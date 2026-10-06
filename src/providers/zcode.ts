/**
 * ZCode provider — native headless `zcode.cjs -p/--resume ... --json`.
 *
 * Verified on ZCode desktop 3.11.2 / bundled CLI 0.16.5:
 *  - The desktop app does not install a standalone CLI on PATH; the bundled
 *    entry is /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs and must
 *    be run with a sqlite-capable Node (>=22).
 *  - Headless mode needs a runtime model config. The desktop's enabled provider
 *    in ~/.zcode/v2/config.json (coding-plan subscription) is injected via env:
 *    ZCODE_MODEL / ZCODE_BASE_URL / ANTHROPIC_API_KEY (same plumbing the
 *    zcode-acp project uses — consulted as reference, not imported).
 *  - create: `zcode -p <prompt> --cwd <dir> --mode plan --disallowed-tools ... --json`
 *    → stdout JSON { sessionId, response } where `response` is the final answer.
 *  - continue: add `--resume <sess_id>`; same store as the desktop app (verified:
 *    CLI resume sees app-server/desktop sessions and vice versa).
 *  - CLI TUI (`zcode --resume <id>`) is NOT runnable in the desktop-bundle
 *    environment (the @zcode/tui package only ships inside the desktop app's
 *    asar), so manual handoff goes through the desktop app: the bridge mirrors
 *    the session into the desktop tasks index (best-effort, same behaviour as
 *    existing tooling) and hands out `open "zcode://workspace/open?path=..."`.
 */
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExecSpec, ExecOutcome, PreparedExec } from "./types.ts";
import { shQuote } from "../shquote.ts";
import { inviteePermissions } from "./perms.ts";
import { DatabaseSync } from "node:sqlite";

const BRIDGE_TOOLS = ["agent_invite", "agent_continue", "agent_result", "agent_session"];

export const ZCODE_CJS_CANDIDATES = [
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  path.join(os.homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
];

export function zcodeResolveNode(): string {
  const env = process.env.ARB_ZCODE_NODE?.trim();
  if (env && existsSync(env)) return env;
  return process.execPath; // the bridge itself runs on a sqlite-capable Node
}

export function zcodeResolveCjs(): string {
  const env = process.env.ARB_ZCODE_CLI?.trim();
  if (env && existsSync(env)) return env;
  for (const c of ZCODE_CJS_CANDIDATES) if (existsSync(c)) return c;
  throw new Error("未找到 zcode.cjs（ZCode 桌面应用未安装？）。可用 ARB_ZCODE_CLI 指定路径。");
}

interface V2Provider {
  enabled?: boolean;
  kind?: string;
  options?: { baseURL?: string; apiKey?: string };
  models?: Record<string, { name?: string; limit?: { context?: number; output?: number }; reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string } }>;
}

/** Read the desktop's enabled provider (subscription account) — never logged. */
export function zcodeProviderEnv(): { env: Record<string, string>; providerId: string; modelId: string } {
  const cfgPath = path.join(os.homedir(), ".zcode", "v2", "config.json");
  let cfg: { provider?: Record<string, V2Provider> } = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e: any) {
    throw new Error(`无法读取 ZCode 桌面配置 ${cfgPath}: ${e.message}`);
  }
  for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
    if (p?.enabled && p.options?.baseURL && p.options?.apiKey) {
      const modelId = Object.keys(p.models ?? {})[0] ?? "GLM-5.3";
      return {
        env: {
          ZCODE_MODEL: modelId,
          ZCODE_BASE_URL: p.options.baseURL,
          ANTHROPIC_API_KEY: p.options.apiKey,
        },
        providerId: pid,
        modelId,
      };
    }
  }
  throw new Error("~/.zcode/v2/config.json 中没有启用的 provider（请在 ZCode 桌面应用确认已登录订阅）。");
}

export function zcodePrepare(spec: ExecSpec): PreparedExec {
  const { env } = zcodeProviderEnv();
  const args: string[] = [];
  if (spec.nativeSessionId) args.push("--resume", spec.nativeSessionId);
  args.push(
    "-p", spec.prompt,
    "--cwd", spec.workspace,
    "--mode", inviteePermissions() === "readonly" ? "plan" : "yolo",
    "--disallowed-tools", BRIDGE_TOOLS.map((t) => `mcp__${spec.bridgeServerName}__${t}`).join(","),
    "--json",
  );
  return {
    command: zcodeResolveNode(),
    args: [zcodeResolveCjs(), ...args],
    cwd: spec.workspace,
    env,
    stdin: null,
  };
}

export function zcodeOutcome(stdout: string, stderr: string, code: number | null): ExecOutcome {
  // `--json` pretty-prints a multi-line object; try whole-output parse first,
  // then any embedded JSON object (defensive against extra trailing output).
  const candidates: string[] = [];
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const line of trimmed.split("\n").reverse()) candidates.push(line);
  for (const cand of candidates) {
    let d: any;
    try { d = JSON.parse(cand); } catch { continue; }
    if (typeof d !== "object" || d === null) continue;
    if (typeof d.sessionId === "string" && d.sessionId.startsWith("sess_")) {
      if (code === 0 && typeof d.response === "string" && d.response.length > 0) {
        return { ok: true, answer: d.response, nativeSessionId: d.sessionId };
      }
      let reason = typeof d.error === "string" && d.error
        ? d.error
        : code === 0 ? "zcode 返回了空的最终答复" : `zcode 退出码 ${code}`;
      if (/model creation failed/i.test(reason)) {
        reason += "(常见原因:该会话正在 ZCode 桌面/其他窗口中打开而被持有。请关闭该会话窗口后重试本轮。)";
      }
      return { ok: false, answer: null, nativeSessionId: d.sessionId, error: reason };
    }
  }
  const tail = (stderr || stdout).trim().slice(0, 400);
  return { ok: false, answer: null, nativeSessionId: null, error: `zcode -p 未返回 JSON 结果 (exit=${code}): ${tail}` };
}

/**
 * Best-effort mirror of a bridge-created session into the desktop app's tasks
 * index so the user can find and continue it in the ZCode desktop UI. This
 * mirrors existing local tooling behaviour; failures never block the bridge.
 */
export function zcodeSyncTaskIndex(params: { sessionId: string; workspace: string; title: string; updatedAt?: number }): { ok: boolean; detail: string } {
  try {
    const dbPath = path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");
    if (!existsSync(dbPath)) return { ok: false, detail: "tasks-index.sqlite 不存在" };
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    db.exec("PRAGMA busy_timeout = 5000");
    const now = params.updatedAt ?? Date.now();
    // 与桌面端一致的字段约定(task_status=completed 表示一轮已结束;provider=glm)
    db.prepare(
      `INSERT INTO tasks(workspace_key, workspace_path, task_id, title, task_status, provider, mode, created_at, updated_at, pinned, archived, deleted)
       VALUES(?,?,?,?,?,?,?,?,?,0,0,0)
       ON CONFLICT(workspace_key, task_id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`,
    ).run(params.workspace, params.workspace, params.sessionId, params.title.slice(0, 120), "completed", "glm", "plan", now, now);
    db.close();
    return { ok: true, detail: "已同步到 ZCode 桌面任务列表" };
  } catch (e: any) {
    return { ok: false, detail: `tasks-index 同步失败(不影响桥运行): ${e.message}` };
  }
}


export function zcodeHandoff(p: { workspace: string; nativeSessionId: string; title: string | null }): { kind: "command"; command: string; note: string } {
  const titleHint = p.title ? `在任务列表中找到会话「${p.title.slice(0, 40)}」(${p.nativeSessionId})并继续对话。` : `在任务列表中找到会话 ${p.nativeSessionId} 并继续对话。`;
  return {
    kind: "command",
    command: `open ${shQuote(`zcode://workspace/open?path=${encodeURIComponent(p.workspace)}`)}`,
    note:
      `ZCode 手动接管入口(桌面应用)。${titleHint}` +
      `完成后退出该会话并告诉主持人“我看完了,继续”。` +
      `(本机 ZCode 桌面包未附带可用的终端 TUI 运行时，原生恢复以桌面应用为准；桥会在创建会话时把该会话同步到桌面任务列表。)`,
  };
}
