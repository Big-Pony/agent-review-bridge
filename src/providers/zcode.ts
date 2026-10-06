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
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
/**
 * ZCode 3.14+ 的 CLI 启动时按 <configRoot>/runtime/provider/<platform>/<appVersion>/endpoint-<hash>/
 * 查找 zcode-builtin.json;宿主终端环境没有 ZCODE_APP_VERSION 时,CLI 用内部默认版本号去找,
 * 找不到就退回 bundle 内路径(不存在)并报"无法定位 CLI ZCode Built-in Provider Config"。
 * 因此桥在注入 provider 凭据的同时补上 appVersion:优先沿用现有 env,其次取桌面 Info.plist
 * 版本,再校验/回退为磁盘上实际存在 active 配置的最新版本目录。
 */
function resolveZcodeAppVersion(): string | null {
  const existing = process.env.ZCODE_APP_VERSION?.trim();
  if (existing) return existing;
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const base = path.join(os.homedir(), ".zcode", "v2", "runtime", "provider", `${platform}-${arch}`);
  const hasActive = (ver: string) => {
    try {
      for (const ep of readdirSync(path.join(base, ver))) {
        if (existsSync(path.join(base, ver, ep, "zcode-builtin.json"))) return true;
      }
    } catch { /* version dir missing */ }
    return false;
  };
  // 桌面 app 版本优先
  try {
    const plist = readFileSync("/Applications/ZCode.app/Contents/Info.plist", "utf8");
    const m = plist.match(/CFBundleShortVersionString\s*=>\s*"?([^"\n<]+)/) ?? plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)/);
    const ver = m?.[1]?.trim();
    if (ver && hasActive(ver)) return ver;
  } catch { /* no plist → fall through */ }
  // 回退:磁盘上存在 active 配置的最新版本目录(按 semver 粗比较)
  try {
    const vers = readdirSync(base).filter((v) => /^\d+\.\d+/.test(v) && hasActive(v));
    vers.sort((a, b) => {
      const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d) return d;
      }
      return 0;
    });
    if (vers.length > 0) return vers[0];
  } catch { /* no runtime dir → give up silently */ }
  return null;
}

function findBuiltinProviderConfig(appVersion: string): string | null {
  try {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
    const verDir = path.join(os.homedir(), ".zcode", "v2", "runtime", "provider", `${platform}-${arch}`, appVersion);
    for (const ep of readdirSync(verDir)) {
      const f = path.join(verDir, ep, "zcode-builtin.json");
      if (existsSync(f)) return f;
    }
  } catch { /* missing */ }
  return null;
}

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
      const env: Record<string, string> = {
        ZCODE_MODEL: modelId,
        ZCODE_BASE_URL: p.options.baseURL,
        ANTHROPIC_API_KEY: p.options.apiKey,
      };
      const appVersion = resolveZcodeAppVersion();
      if (appVersion) env.ZCODE_APP_VERSION = appVersion;
      // ZCode 3.14+ 的 CLI 在无桌面 env 的终端里启动时,会因找不到内置 provider 配置而直接报
      // "无法定位 CLI ZCode Built-in Provider Config"。桌面进程靠这两个 env 指到实际文件;
      // 桥为干净环境补齐(沿用已有值;否则解析磁盘上的 active 文件)。
      const personal = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
      if (process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()) {
        env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim();
      } else if (existsSync(personal)) {
        env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
      }
      if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim()) {
        env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE.trim();
      } else if (appVersion) {
        const builtin = findBuiltinProviderConfig(appVersion);
        if (builtin) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
      }
      return { env, providerId: pid, modelId };
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
