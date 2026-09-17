/**
 * Codex provider — native `codex exec` (create) / `codex exec resume` (continue).
 *
 * Verified on codex-cli 0.153.4 (ChatGPT subscription login):
 *  - create: `codex exec --json -s read-only -C <dir> --skip-git-repo-check -` reads the
 *    prompt from stdin; `thread.started` carries the native thread id; the final
 *    answer is the LAST `item.completed` with item.type == "agent_message".
 *  - resume: the subcommand accepts `-c` config overrides but NOT `-s`/`-C`, so
 *    the sandbox comes from `-c sandbox_mode="..."` and the workspace from
 *    the process cwd.
 *  - permissions: default max = `-s danger-full-access` (owner decision
 *    2026-09-13, avoid permission stalls); ARB_INVITEE_PERMISSIONS=readonly
 *    restores `-s read-only`.
 *  - bridge self-disable: `-c mcp_servers.<name>={command=...,args=[...],enabled=false}`
 *    replaces the whole entry (verified: target server disabled, others untouched).
 *  - interactive recovery: `codex resume <thread_id>` (verified; the TUI itself
 *    prints this command on exit).
 */
import type { ExecSpec, ExecOutcome, HandoffEntry } from "./types.ts";
import { shQuote } from "../shquote.ts";
import { inviteePermissions } from "./perms.ts";
import { resolveCliBin } from "./resolve.ts";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX_MODE = () => (inviteePermissions() === "readonly" ? "read-only" : "danger-full-access");

export function codexPrepare(spec: ExecSpec): { command: string; args: string[]; cwd: string; stdin: string } {
  const bin = resolveCliBin("codex", spec.bin);
  if (!bin) throw new Error(NOT_FOUND);
  const disable = `mcp_servers.${spec.bridgeServerName}={command="${spec.bridgeCommand}",args=["${spec.bridgeServerArg}"],enabled=false}`;
  if (spec.nativeSessionId) {
    return {
      command: bin,
      args: [
        "exec", "resume", spec.nativeSessionId,
        "--json",
        "-c", `sandbox_mode="${SANDBOX_MODE()}"`,
        "-c", disable,
        "--skip-git-repo-check",
        "-",
      ],
      cwd: spec.workspace,
      stdin: spec.prompt,
    };
  }
  return {
    command: bin,
    args: [
      "exec", "--json",
      "-s", SANDBOX_MODE(),
      "-C", spec.workspace,
      "--skip-git-repo-check",
      "-c", disable,
      "-",
    ],
    cwd: spec.workspace,
    stdin: spec.prompt,
  };
}

export function codexOutcome(stdout: string, _stderr: string, code: number | null): ExecOutcome {
  let nativeSessionId: string | null = null;
  const messages: string[] = [];
  let failure: string | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: any;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type === "thread.started" && e.thread_id) nativeSessionId = String(e.thread_id);
    else if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") {
      messages.push(e.item.text);
    } else if (e.type === "turn.failed") {
      failure = e.error?.message ?? "turn failed";
    } else if (e.type === "error" && typeof e.message === "string") {
      // Reconnect/transient notices are informational; remember the last one.
      if (!/reconnecting/i.test(e.message)) failure = e.message;
    }
  }
  const answer = messages.length > 0 ? messages[messages.length - 1] : null;
  if (code === 0 && answer != null) return { ok: true, answer, nativeSessionId };
  const reason = failure
    ?? (answer != null ? `codex exited with code ${code} after producing a message` : `codex exited with code ${code} without a final agent message`)
    ?? "codex failed";
  // 提交无法确认完成时由 runner 标记 interrupted；此处只描述失败。
  return { ok: false, answer, nativeSessionId, error: reason };
}

export function codexHandoff(p: { workspace: string; nativeSessionId: string }): HandoffEntry {
  return {
    kind: "command",
    command: `cd ${shQuote(p.workspace)} && codex resume ${shQuote(p.nativeSessionId)}`,
    note: "Codex 原生交互恢复(需要本机 codex CLI 登录)。退出后告诉主持人“我看完了,继续”。",
  };
}

/** V1 preflight: ChatGPT subscription login (auth.json shape), no conflicting API-key env. */
const NOT_FOUND =
  "未找到 codex CLI(已搜索 PATH、~/.local/bin、~/.codex/packages、Homebrew 与 ChatGPT.app)。请安装 codex 或在桥的 MCP 配置 env 里设置 ARB_CODEX_BIN=<绝对路径>。";

/** V1 preflight: ChatGPT subscription login (auth.json shape), no conflicting API-key env. */
export function codexPreflight(): { ok: boolean; detail: string } {
  if (process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      detail: "环境变量 OPENAI_API_KEY 已设置，可能导致 Codex 调用走单独计费 API 而非本地 ChatGPT 订阅登录。请在该环境清除后重试（本桥不会替你静默切换鉴权）。",
    };
  }
  // `codex login status` prints nothing when stdout is not a TTY (0.153.x),
  // so the verdict is read from $CODEX_HOME/auth.json's key shape — values
  // are never read or logged.
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const authPath = path.join(codexHome, "auth.json");
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    if (raw.tokens && typeof raw.tokens === "object") return { ok: true, detail: "ChatGPT 订阅登录(auth.json tokens)" };
    if ("OPENAI_API_KEY" in raw) return { ok: false, detail: "Codex 为 API key 鉴权而非订阅登录(auth.json 含 OPENAI_API_KEY)。请用 `codex login` 切换到 ChatGPT 订阅。" };
    return { ok: false, detail: `无法从 ${authPath} 确认订阅登录(既无 tokens 也无 API key)。请运行 codex login。` };
  } catch (e: any) {
    return { ok: false, detail: `读取 codex 登录状态失败(${e.message})。请确认本机已 codex login。` };
  }
}

