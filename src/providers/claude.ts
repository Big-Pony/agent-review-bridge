/**
 * Claude Code provider — native `claude -p --output-format json`.
 *
 * Verified on claude 2.1.268:
 *  - create: prompt on stdin, session cwd = process cwd; the JSON result carries
 *    `session_id` and `result` (final answer, verbatim).
 *  - continue: same flags plus `--resume <session_id>`; the id is echoed back.
 *  - permissions: default max (ARB_INVITEE_PERMISSIONS=max, per owner decision
 *    2026-09-13: invitees run with full permissions to avoid permission stalls
 *    in headless rounds); ARB_INVITEE_PERMISSIONS=readonly restores
 *    `--permission-mode plan`.
 *  - bridge self-disable: `--disallowedTools mcp__<server>__<tool>` for each of
 *    the four bridge tools.
 *  - interactive recovery: `claude --resume <session_id>` in the workspace.
 *  - auth: the machine's local login is used as-is. An API routing config
 *    (ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY via env or ~/.claude/settings.json)
 *    is ALLOWED by default (owner decision); set ARB_REQUIRE_CLAUDE_SUBSCRIPTION=1
 *    to make the bridge refuse routed API billing instead.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecSpec, ExecOutcome, HandoffEntry, PreparedExec } from "./types.ts";
import { shQuote } from "../shquote.ts";
import { inviteePermissions } from "./perms.ts";
import { resolveCliBin } from "./resolve.ts";
import { existsSync } from "node:fs";

const BRIDGE_TOOLS = ["agent_invite", "agent_continue", "agent_result", "agent_session"];

function disallowedFlags(serverName: string): string[] {
  return [
    "--disallowedTools",
    BRIDGE_TOOLS.map((t) => `mcp__${serverName}__${t}`).join(","),
  ];
}

export function claudePrepare(spec: ExecSpec): PreparedExec {
  const bin = resolveCliBin("claude", spec.bin);
  if (!bin) throw new Error("未找到 claude CLI(已搜索 PATH、~/.local/bin、~/.local/share/claude、Homebrew)。请安装 claude 或在桥的 MCP 配置 env 里设置 ARB_CLAUDE_BIN=<绝对路径>。");
  const args = ["-p", "--output-format", "json"];
  args.push(...(inviteePermissions() === "readonly" ? ["--permission-mode", "plan"] : ["--dangerously-skip-permissions"]));
  args.push(...disallowedFlags(spec.bridgeServerName));
  if (spec.nativeSessionId) args.push("--resume", spec.nativeSessionId);
  return { command: bin, args, cwd: spec.workspace, stdin: spec.prompt };
}

export function claudeOutcome(stdout: string, stderr: string, code: number | null): ExecOutcome {
  // The final line of stdout is the JSON result object.
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (typeof d !== "object" || d === null) continue;
    if (d.type !== "result" && d.session_id === undefined) continue;
    const sid = typeof d.session_id === "string" ? d.session_id : null;
    if (d.is_error === true || d.subtype === "error_max_turns" || d.subtype === "error_during_execution") {
      return { ok: false, answer: null, nativeSessionId: sid, error: String(d.result ?? d.subtype ?? "claude reported an error") };
    }
    if (typeof d.result === "string") return { ok: true, answer: d.result, nativeSessionId: sid };
  }
  const tail = (stderr || stdout).trim().slice(0, 400);
  return { ok: false, answer: null, nativeSessionId: null, error: `claude -p 未返回 JSON 结果 (exit=${code}): ${tail}` };
}

export function claudeHandoff(p: { workspace: string; nativeSessionId: string }): HandoffEntry {
  return {
    kind: "command",
    command: `cd ${shQuote(p.workspace)} && claude --resume ${shQuote(p.nativeSessionId)}`,
    note: "Claude Code 原生交互恢复(需要本机 claude CLI 登录)。首次进入可能弹出目录信任确认,选择信任即可。退出后告诉主持人“我看完了,继续”。",
  };
}

interface ClaudeSettingsEnv {
  env?: Record<string, string>;
}

/**
 * Auth preflight. The owner decided (2026-09-13) that the machine's DeepSeek
 * API routing is the intended local setup, so it is allowed by default and
 * only reported. ARB_REQUIRE_CLAUDE_SUBSCRIPTION=1 restores the strict
 * subscription-only behaviour (refuse with an explanation, never silently
 * re-route).
 */
export function claudePreflight(_bin: string): { ok: boolean; detail: string } {
  const routingVars: string[] = [];
  const check = (k: string, v: string | undefined) => {
    if (v && v.trim()) routingVars.push(k);
  };
  check("ANTHROPIC_BASE_URL", process.env.ANTHROPIC_BASE_URL);
  check("ANTHROPIC_AUTH_TOKEN", process.env.ANTHROPIC_AUTH_TOKEN);
  check("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
  // claude merges ~/.claude/settings.json `env` into its process env
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettingsEnv;
      for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
        check(`~/.claude/settings.json:${k}`, s.env?.[k]);
      }
    }
  } catch {
    // unreadable settings → fall through to env-only judgment
  }
  if (routingVars.length > 0 && process.env.ARB_REQUIRE_CLAUDE_SUBSCRIPTION === "1") {
    return {
      ok: false,
      detail:
        `已启用 ARB_REQUIRE_CLAUDE_SUBSCRIPTION=1,而检测到 ${routingVars.join(", ")}(API 计费路由,非订阅登录)。` +
        `按该要求本次调用被拒绝;清除相关配置或去掉该环境变量后重试。`,
    };
  }
  if (routingVars.length > 0) {
    return { ok: true, detail: `本机 Claude API 路由(${routingVars.length} 项配置,默认放行)` };
  }
  return { ok: true, detail: "本地订阅登录(未检测到 API 路由覆盖)" };
}
