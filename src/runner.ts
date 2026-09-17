/**
 * Per-request execution process.
 *
 * The MCP server spawns `node runner.ts <request_id> <mode> <prompt>` detached
 * for each round. This process owns the native backend invocation end-to-end:
 * spawn → parse → write result into SQLite → exit. Because it is detached, an
 * in-flight round survives an MCP-server (host) restart; its DB writes are the
 * single source of truth.
 *
 * Cancellation: SIGTERM here triggers a backend process-group kill and a
 * 'cancelled' terminal state (never a silent re-run).
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  getDb, getRequest, getParticipant, getDiscussion,
  finishRequest, recordNativeSessionId, updateParticipant, setRequestPids,
  type AgentKind,
} from "./state.ts";
import { logsDir, answerFileFor, maxInlineBytes } from "./paths.ts";
import { codexPrepare, codexOutcome } from "./providers/codex.ts";
import { claudePrepare, claudeOutcome } from "./providers/claude.ts";
import { zcodePrepare, zcodeOutcome, zcodeSyncTaskIndex, zcodeResolveCjs, zcodeResolveNode } from "./providers/zcode.ts";
import type { PreparedExec } from "./providers/types.ts";

const requestId = process.argv[2];
const mode = process.argv[3] === "create" ? "create" : "continue";
const prompt = process.argv[4] ?? "";

if (!requestId || !prompt) {
  console.error("usage: runner.ts <request_id> <create|continue> <prompt>");
  process.exit(2);
}

getDb(); // initialise schema before any use
const req = getRequest(requestId);
if (!req) { console.error(`request ${requestId} not found`); process.exit(2); }
const participant = getParticipant(req.participant_id);
if (!participant) { console.error(`participant ${req.participant_id} not found`); process.exit(2); }
const discussion = getDiscussion(participant.discussion_id);
if (!discussion) { console.error(`discussion ${participant.discussion_id} not found`); process.exit(2); }

if (!existsSync(logsDir())) mkdirSync(logsDir(), { recursive: true });
const logFile = path.join(logsDir(), `${requestId}.log`);
const log = (m: string) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* best-effort */ }
};

const BRIDGE_SERVER_NAME = process.env.ARB_MCP_SERVER_NAME || "agent_review_bridge";
const BRIDGE_COMMAND = process.env.ARB_BRIDGE_COMMAND || process.execPath;
const BRIDGE_ARG0 = process.env.ARB_BRIDGE_ARG0 || "";

function prepare(agent: AgentKind): PreparedExec {
  const specBase = {
    workspace: participant.workspace,
    prompt,
    nativeSessionId: mode === "continue" ? participant.native_session_id : null,
    bridgeServerName: BRIDGE_SERVER_NAME,
    bridgeCommand: BRIDGE_COMMAND,
    bridgeServerArg: BRIDGE_ARG0,
  };
  if (agent === "codex") {
    return codexPrepare({ ...specBase, bin: process.env.ARB_CODEX_BIN });
  }
  if (agent === "claude") {
    return claudePrepare({ ...specBase, bin: process.env.ARB_CLAUDE_BIN });
  }
  return zcodePrepare(specBase);
}

let backend: ReturnType<typeof spawn> | null = null;
let terminating = false;

async function killBackendGroup(): Promise<void> {
  if (!backend || backend.pid == null) return;
  const pid = backend.pid;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 5000));
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  try { backend.kill("SIGKILL"); } catch { /* already gone */ }
}

process.on("SIGTERM", async () => {
  if (terminating) return;
  terminating = true;
  log("runner: SIGTERM — cancelling");
  await killBackendGroup();
  try {
    finishRequest(requestId, "cancelled", null, null, "用户/主持人取消了本轮请求");
    updateParticipant(participant.id, { status: "idle" });
  } catch (e: any) { log(`runner: cancel write failed: ${e.message}`); }
  process.exit(0);
});

function shortTitle(): string {
  const first = prompt.trim().split("\n")[0] ?? "";
  return first.slice(0, 60) || "(空任务)";
}

async function main(): Promise<void> {
  let prepared;
  try {
    prepared = prepare(participant.agent);
  } catch (e: any) {
    log(`runner: prepare failed: ${e.message}`);
    finishRequest(requestId, "failed", null, null, e.message);
    updateParticipant(participant.id, { status: "idle" });
    process.exit(1);
  }
  log(`runner: spawning ${prepared.command} ${prepared.args.map((a) => a === prompt ? `<prompt ${prompt.length} chars>` : JSON.stringify(a)).join(" ").slice(0, 600)}`);
  log(`runner: cwd=${prepared.cwd} stdin=${prepared.stdin ? "yes" : "no"} env_keys=${Object.keys(prepared.env ?? {}).join(",")}`);

  backend = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: { ...process.env, ...(prepared.env ?? {}) },
    detached: true, // own group → kill(-pid) reaps shell children too
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  backend.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
  backend.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  if (!backend.pid) {
    log(`runner: spawn returned no pid for ${prepared.command}`);
    finishRequest(requestId, "failed", null, null, `无法启动 ${participant.agent} 后端进程(${prepared.command})。若为 GUI 启动的宿主,PATH 可能不含该 CLI;可在桥的 MCP 配置 env 设置 ARB_${participant.agent.toUpperCase()}_BIN=<绝对路径>。`);
    updateParticipant(participant.id, { status: "idle" });
    process.exit(1);
  }
  setRequestPids(requestId, process.pid, backend.pid);

  const exited: Promise<number | null> = new Promise((resolve) => {
    backend!.on("error", (err: NodeJS.ErrnoException) => {
      // spawn failure: the backend definitively never accepted the task
      log(`runner: spawn error: ${err.message}`);
      finishRequest(requestId, "failed", null, null,
        `无法启动 ${participant.agent} 后端: ${err.message}（请检查 CLI 安装与环境变量 ARB_CODEX_BIN/ARB_CLAUDE_BIN/ARB_ZCODE_CLI）`);
      updateParticipant(participant.id, { status: "idle" });
      resolve(-1);
    });
    backend!.on("exit", (code) => resolve(code));
  });

  if (prepared.stdin != null) {
    backend.stdin!.write(prepared.stdin);
    backend.stdin!.end();
  } else {
    backend.stdin!.end();
  }

  const code = await exited;
  if (terminating) return; // SIGTERM path already wrote 'cancelled'
  log(`runner: backend exited code=${code} stdout=${stdout.length}B stderr=${stderr.length}B`);

  const outcome =
    participant.agent === "codex" ? codexOutcome(stdout, stderr, code)
    : participant.agent === "claude" ? claudeOutcome(stdout, stderr, code)
    : zcodeOutcome(stdout, stderr, code);

  if (outcome.nativeSessionId) {
    recordNativeSessionId(requestId, outcome.nativeSessionId);
    if (outcome.nativeSessionId !== participant.native_session_id) {
      updateParticipant(participant.id, { native_session_id: outcome.nativeSessionId });
    }
  }

  if (outcome.ok && outcome.answer != null) {
    let answer: string | null = null;
    let file: string | null = null;
    if (Buffer.byteLength(outcome.answer, "utf8") > maxInlineBytes()) {
      file = answerFileFor(participant.discussion_id, requestId);
      writeFileSync(file, outcome.answer, "utf8");
    } else {
      answer = outcome.answer;
    }
    finishRequest(requestId, "completed", answer, file, null);
    updateParticipant(participant.id, { status: "idle", title: participant.title ?? shortTitle() });
    if (participant.agent === "zcode" && outcome.nativeSessionId) {
      const sync = zcodeSyncTaskIndex({
        sessionId: outcome.nativeSessionId,
        workspace: participant.workspace,
        title: shortTitle(),
      });
      log(`runner: task-index sync ${sync.ok ? "ok" : sync.detail}`);
    }
    log(`runner: completed answer=${answer ? `${answer.length} chars inline` : `file ${file}`}`);
  } else {
    finishRequest(requestId, "failed", null, null, outcome.error ?? `${participant.agent} 本轮失败`);
    updateParticipant(participant.id, { status: "idle" });
    log(`runner: failed: ${outcome.error}`);
  }
  process.exit(0);
}

main().catch((e: any) => {
  log(`runner: fatal ${e?.stack ?? e}`);
  try {
    finishRequest(requestId, "failed", null, null, `桥执行进程内部错误: ${e?.message ?? e}`);
    updateParticipant(participant.id, { status: "idle" });
  } catch { /* nothing more to do */ }
  process.exit(1);
});
