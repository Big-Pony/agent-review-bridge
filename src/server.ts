/**
 * agent-review-bridge — 本地多 Agent 评审桥 (MCP stdio server).
 *
 * One bridge process serves one host (Codex / Claude Code / ZCode). Hosts
 * install the same entry; the bridge coordinates multiple local processes via
 * its SQLite state store and detached per-request runner processes.
 *
 * Tools: agent_invite / agent_continue / agent_result / agent_session.
 * 主持规则见 ../hosts/HOST_INSTRUCTIONS.md；本文件只做协议与状态机。
 */
import { createInterface } from "node:readline";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  getDb, createDiscussion, getDiscussion, createParticipant, getParticipant,
  findParticipantByAgent, updateParticipant, listParticipants,
  createRequest, getRequest, latestRequest, runningRequests,
  finishRequest, recoverInterrupted, setRequestPids,
  type AgentKind, type RequestRow, type ParticipantRow,
} from "./state.ts";
import { codexPreflight, codexHandoff } from "./providers/codex.ts";
import { claudePreflight, claudeHandoff } from "./providers/claude.ts";
import { zcodeHandoff } from "./providers/zcode.ts";

const SERVER_VERSION = "1.0.0";
const here = path.dirname(fileURLToPath(import.meta.url));

const AGENTS: AgentKind[] = ["codex", "claude", "zcode"];

// ---------- MCP plumbing (newline-delimited JSON-RPC over stdio) ----------

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const write = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id: number | string | null, result: object) => write({ jsonrpc: "2.0", id, result });
const replyErr = (id: number | string | null, code: number, message: string) =>
  write({ jsonrpc: "2.0", id, error: { code, message } });

function toolResult(id: number | string | null, payload: object, isError = false) {
  reply(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });
}

const TOOL_DEFS = [
  {
    name: "agent_invite",
    description:
      "邀请一个本地 agent(codex/claude/zcode)作为被评审者加入讨论:在指定工作区创建其原生会话并启动首轮任务。" +
      "同一讨论重复邀请同种工具会返回已有参与者并提示改用 agent_continue,不会重复执行任务。",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: AGENTS, description: "被邀请工具" },
        workspace: { type: "string", description: "绝对项目目录(讨论绑定的实际工作区)" },
        prompt: { type: "string", description: "首轮任务全文(含目标、材料、约束、背景)" },
        discussion_id: { type: "string", description: "加入已有讨论时提供" },
        native_session_id: { type: "string", description: "导入模式:使用一个已存在的原生会话 ID(zcode 为 sess_...,codex/claude 为 UUID)作为参与者,首轮任务直接发到该会话。该会话当前不能正被对应工具打开(否则会被持有锁拒绝)" },
      },
      required: ["agent", "workspace", "prompt"],
    },
  },
  {
    name: "agent_continue",
    description: "在同一参与者的原生会话上继续一轮(仅发送新问题与必要补充材料)。参与者忙碌或手动接管时返回对应状态。",
    inputSchema: {
      type: "object",
      properties: {
        participant_id: { type: "string" },
        prompt: { type: "string", description: "本轮新任务/追问全文" },
      },
      required: ["participant_id", "prompt"],
    },
  },
  {
    name: "agent_result",
    description:
      "读取一轮请求的结果,桥侧挂起等待:完成立即返回;到时未完成返回 pending(用同一 request_id 继续,这不是失败)。" +
      "wait_seconds 默认 25——ZCode 桌面对 MCP 调用有 30s 硬超时,请保持默认;若宿主允许更长调用(如 Claude Code 配置过 MCP_TOOL_TIMEOUT)," +
      "可一次给到 600 减少重试次数,桥会发进度通知保活。成功返回本轮原样答复或超大答复文件路径;失败附原因。",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        wait_seconds: { type: "number", description: "本次最长等待秒数(默认30,<=0则立即返回)" },
      },
      required: ["request_id"],
    },
  },
  {
    name: "agent_session",
    description: "会话管理:info 查询参与者状态;handoff 手动接管并返回原生恢复入口;release 交回主持人;cancel 取消当前请求。",
    inputSchema: {
      type: "object",
      properties: {
        participant_id: { type: "string" },
        action: { type: "string", enum: ["info", "handoff", "release", "cancel"] },
      },
      required: ["participant_id", "action"],
    },
  },
];

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function pidAlive(pid: number | null | undefined): boolean {
  if (pid == null || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

function normalizeWorkspace(input: string): string {
  if (!input || typeof input !== "string") throw new Error("workspace 不能为空");
  if (!path.isAbsolute(input)) throw new Error(`workspace 必须是绝对目录: ${input}`);
  const st = statSync(input); // throws for missing paths
  if (!st.isDirectory()) throw new Error(`workspace 不是目录: ${input}`);
  return realpathSync(input);
}

function preflight(agent: AgentKind): { ok: boolean; detail: string } {
  if (agent === "codex") return codexPreflight();
  if (agent === "claude") return claudePreflight(process.env.ARB_CLAUDE_BIN || "claude");
  // zcode 的 provider 读取在 runner 内完成;此处只做入口存在性检查的轻量版
  return { ok: true, detail: "zcode(在执行时读取桌面已配置的订阅 provider)" };
}

function spawnRunner(requestId: string, mode: "create" | "continue", prompt: string): void {
  const runnerPath = path.join(here, "runner.ts");
  const child = spawn(process.execPath, ["--no-warnings", runnerPath, requestId, mode, prompt], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ARB_BRIDGE_COMMAND: process.env.ARB_BRIDGE_COMMAND || process.execPath,
      ARB_BRIDGE_ARG0: process.env.ARB_BRIDGE_ARG0 || path.join(here, "server.ts"),
    },
  });
  child.unref();
  setRequestPids(requestId, child.pid, null);
}

function startRound(participant: ParticipantRow, mode: "create" | "continue", prompt: string) {
  const pre = preflight(participant.agent);
  if (!pre.ok) {
    return { __usage_error: true, error: `预检失败(${participant.agent}): ${pre.detail}` };
  }
  const req = createRequest(participant.id);
  updateParticipant(participant.id, { status: "running" });
  spawnRunner(req.id, mode, prompt);
  return {
    discussion_id: participant.discussion_id,
    participant_id: participant.id,
    request_id: req.id,
    status: "running",
    note: `已启动(${pre.detail})。用 agent_result 等待本轮答复;pending 时继续等待同一 request_id,不要重新邀请。`,
  };
}

function requestPayload(r: RequestRow) {
  const p: Record<string, unknown> = {
    request_id: r.id,
    participant_id: r.participant_id,
    status: r.status,
  };
  if (r.status === "completed") {
    if (r.answer_file) {
      p.answer_file = r.answer_file;
      p.note = "本轮答复超出单次工具结果大小,已原样写入该 UTF-8 文件,请读取文件获得完整正文。";
    } else {
      p.answer = r.answer ?? "";
    }
  }
  if (r.error) p.error = r.error;
  if (r.native_session_id) p.native_session_id = r.native_session_id;
  return p;
}

// ---------- tool handlers ----------

async function handleInvite(params: any) {
  const agent = params?.agent as AgentKind;
  if (!AGENTS.includes(agent)) return { __usage_error: true, error: `agent 必须是 ${AGENTS.join("/")},收到: ${agent}` };
  const prompt = typeof params?.prompt === "string" ? params.prompt : "";
  if (!prompt.trim()) return { __usage_error: true, error: "prompt 不能为空" };
  let ws: string;
  try { ws = normalizeWorkspace(params?.workspace ?? ""); } catch (e: any) { return { error: e.message }; }

  let discussionId: string;
  if (params?.discussion_id) {
    const disc = getDiscussion(String(params.discussion_id));
    if (!disc) return { __usage_error: true, error: `讨论 ${params.discussion_id} 不存在` };
    if (realpathSync(disc.workspace) !== ws) {
      return { __usage_error: true, error: `工作区不一致:讨论绑定 ${disc.workspace},本次请求 ${ws}。续聊不能切换目录。` };
    }
    discussionId = disc.id;
  } else {
    const disc = createDiscussion(ws, process.env.ARB_HOST || "unknown");
    discussionId = disc.id;
  }

  const existing = findParticipantByAgent(discussionId, agent);
  if (existing) {
    return {
      discussion_id: discussionId,
      participant_id: existing.id,
      status: "already_participating",
      note: `该讨论已有 ${agent} 参与者(原生会话 ${existing.native_session_id ?? "尚未创建"})。请用 agent_continue 在原会话上继续,不要重复邀请或重新执行本 prompt。`,
    };
  }
  const participant = createParticipant(discussionId, agent, ws);
  const adoptId = typeof params?.native_session_id === "string" ? params.native_session_id.trim() : "";
  if (adoptId) {
    // 导入已有会话:登记为参与者并直接在该会话上执行首轮(continue 路径 = resume 该 ID)
    updateParticipant(participant.id, { native_session_id: adoptId, title: "导入的原生会话" });
    const started = startRound(participant, "continue", prompt);
    return { discussion_id: discussionId, adopted: true, native_session_id: adoptId, ...started };
  }
  const started = startRound(participant, "create", prompt);
  return { discussion_id: discussionId, ...started };
}

function handleContinue(params: any) {
  const participant = getParticipant(String(params?.participant_id ?? ""));
  if (!participant) return { __usage_error: true, error: `参与者 ${params?.participant_id} 不存在` };
  const prompt = typeof params?.prompt === "string" ? params.prompt : "";
  if (!prompt.trim()) return { __usage_error: true, error: "prompt 不能为空" };
  if (participant.status === "running") {
    const latest = latestRequest(participant.id);
    return {
      participant_id: participant.id,
      status: "busy",
      ...(latest ? { request_id: latest.id } : {}),
      note: `${participant.agent} 参与者正在执行上一轮。请先用 agent_result 等待或用 agent_session cancel 取消;不会暗中排队或分叉会话。`,
    };
  }
  if (participant.status === "handoff") {
    return {
      participant_id: participant.id,
      status: "handoff",
      note: "该参与者处于手动接管状态,桥拒绝派发新任务。请等用户退出原生会话并说“我看完了,继续”后,先调用 agent_session release。",
    };
  }
  if (!participant.native_session_id) {
    return { __usage_error: true, error: `参与者 ${participant.id} 尚无原生会话 ID(首轮未成功创建)。无法续聊;可重新邀请创建新会话(原上下文不延续)。` };
  }
  const latest = latestRequest(participant.id);
  if (latest && latest.status === "interrupted") {
    return {
      __usage_error: true,
      error:
        `上一轮请求 ${latest.id} 处于 interrupted(桥无法确认后端是否已完成,不会自动重发)。` +
        `请先 agent_session cancel 结束该次执行并解除占用,再续聊。`,
    };
  }
  return startRound(participant, "continue", prompt);
}

async function handleResult(params: any, rpcId: number | string | null) {
  const id = String(params?.request_id ?? "");
  let r = getRequest(id);
  if (!r) return { __usage_error: true, error: `请求 ${id} 不存在` };
  const waitSec = Number.isFinite(Number(params?.wait_seconds)) ? Math.max(0, Math.min(Number(params.wait_seconds), 900)) : 25;
  // 长/短等待统一:桥侧挂起直到完成或到时;>20s 的等待按 MCP progress 通知保活
  // (宿主提供 _meta.progressToken 时回显,避免宿主把长调用当作无响应掐断)。
  const progressToken = params?._meta?.progressToken ?? null;
  const deadline = Date.now() + waitSec * 1000;
  let lastProgress = 0;
  while (r!.status === "running" && Date.now() < deadline) {
    await sleep(400);
    r = getRequest(id);
    const elapsed = waitSec * 1000 - (deadline - Date.now());
    if (progressToken !== null && Date.now() - lastProgress > 15000 && elapsed > 15000) {
      lastProgress = Date.now();
      try {
        write({ jsonrpc: "2.0", method: "notifications/progress", params: {
          progressToken,
          progress: Math.floor(elapsed / 1000),
          message: `被邀请者仍在执行(已等 ${Math.floor(elapsed / 1000)}s);桥会在完成时立即返回,无需轮询`,
        } });
      } catch { /* client may have closed */ }
    }
  }
  const payload = requestPayload(r!);
  if (r!.status === "running") {
    return { ...payload, note: "仍在执行(pending)。用同一 request_id 再次调用 agent_result 即可;建议直接给 wait_seconds=600 一次等到完成,桥会保持进度通知,无需频繁轮询。" };
  }
  return payload;
}

async function handleSession(params: any) {
  const participant = getParticipant(String(params?.participant_id ?? ""));
  if (!participant) return { __usage_error: true, error: `参与者 ${params?.participant_id} 不存在` };
  const action = String(params?.action ?? "");
  const latest = latestRequest(participant.id);

  if (action === "info") {
    const others = listParticipants(participant.discussion_id)
      .filter((p) => p.id !== participant.id)
      .map((p) => ({ participant_id: p.id, agent: p.agent, status: p.status, native_session_id: p.native_session_id }));
    return {
      participant_id: participant.id,
      discussion_id: participant.discussion_id,
      agent: participant.agent,
      workspace: participant.workspace,
      native_session_id: participant.native_session_id,
      status: participant.status,
      latest_request: latest ? requestPayload(latest) : null,
      other_participants: others,
    };
  }

  if (action === "handoff") {
    if (participant.status === "running") {
      return {
        participant_id: participant.id,
        status: "busy",
        note: "当前仍有执行中的一轮,不能生成可并发操作的接管入口。等待本轮结束(agent_result)或先 cancel。",
      };
    }
    if (!participant.native_session_id) {
      return { __usage_error: true, error: "该参与者尚无原生会话,无可接管内容。" };
    }
    updateParticipant(participant.id, { status: "handoff" });
    const entry =
      participant.agent === "codex" ? codexHandoff({ workspace: participant.workspace, nativeSessionId: participant.native_session_id })
      : participant.agent === "claude" ? claudeHandoff({ workspace: participant.workspace, nativeSessionId: participant.native_session_id })
      : zcodeHandoff({ workspace: participant.workspace, nativeSessionId: participant.native_session_id, title: participant.title });
    return {
      participant_id: participant.id,
      status: "handoff",
      open_with: entry.command,
      note: entry.note + " 接管期间桥拒绝向该会话派发新任务。",
    };
  }

  if (action === "release") {
    if (participant.status !== "handoff") {
      return { participant_id: participant.id, status: participant.status, note: "该参与者不在手动接管状态,无需 release。" };
    }
    updateParticipant(participant.id, { status: "idle" });
    return {
      participant_id: participant.id,
      status: "idle",
      note: "已解除手动接管,可继续按原原生会话 ID 续聊。手动阶段的新增上下文由原生会话保留;必要时可在追问里询问其新增结论。",
    };
  }

  if (action === "cancel") {
    const needsCleanup = latest && (latest.status === "running" || latest.status === "interrupted");
    if (!needsCleanup) {
      return { participant_id: participant.id, status: participant.status, note: "当前没有执行中的请求,无需取消。" };
    }
    // 1) runner 活着 → SIGTERM 让它杀后端进程组并落 cancelled
    if (pidAlive(latest.runner_pid)) {
      try { process.kill(latest.runner_pid!, "SIGTERM"); } catch { /* raced */ }
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await sleep(300);
        const cur = getRequest(latest.id);
        if (cur && cur.status !== "running") break;
      }
    }
    // 2) runner 已死但后端进程组可能残留 → 直接确认杀掉
    const cur = getRequest(latest.id)!;
    if (cur.status === "interrupted") {
      // 重启遗留的未确认执行:cancel 即主持人确认放弃该次执行
      if (pidAlive(cur.backend_pid)) {
        try { process.kill(-cur.backend_pid!, "SIGKILL"); } catch { try { process.kill(cur.backend_pid!, "SIGKILL"); } catch { /* gone */ } }
        await sleep(500);
      }
      getDb().prepare("UPDATE requests SET status='cancelled', finished_at=?, error=COALESCE(error,'取消:已确认放弃重启前未完成的执行') WHERE id=?").run(Date.now(), latest.id);
    }
    if (cur.status === "running") {
      if (pidAlive(cur.backend_pid)) {
        try { process.kill(-cur.backend_pid!, "SIGKILL"); } catch { try { process.kill(cur.backend_pid!, "SIGKILL"); } catch { /* gone */ } }
        await sleep(500);
      }
      finishRequest(latest.id, "cancelled", null, null, "取消:runner 未响应,桥直接终止了后端进程组");
    }
    const after = getRequest(latest.id)!;
    const pAfter = getParticipant(participant.id)!;
    if (pAfter.status === "running") updateParticipant(participant.id, { status: "idle" });
    return {
      participant_id: participant.id,
      status: "idle",
      cancelled_request: requestPayload(after),
      note: "已取消并确认执行结束,可再次派发或手动接管。",
    };
  }

  return { __usage_error: true, error: `action 必须是 info/handoff/release/cancel,收到: ${action}` };
}

// ---------- dispatch ----------

async function onRequest(msg: JsonRpcMsg): Promise<void> {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      reply(id!, {
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-review-bridge", version: SERVER_VERSION },
      });
      return;
    }
    if (method === "ping") { reply(id!, {}); return; }
    if (method === "tools/list") { reply(id!, { tools: TOOL_DEFS }); return; }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      let payload: any;
      let isErr = false;
      if (name === "agent_invite") payload = await handleInvite(args);
      else if (name === "agent_continue") payload = handleContinue(args);
      else if (name === "agent_result") payload = await handleResult(args, id ?? null);
      else if (name === "agent_session") payload = await handleSession(args);
      else { replyErr(id!, -32601, `unknown tool: ${name}`); return; }
      if (payload && payload.__usage_error === true) { isErr = true; delete payload.__usage_error; }
      toolResult(id!, payload, isErr);
      return;
    }
    replyErr(id!, -32601, `method not found: ${method}`);
  } catch (e: any) {
    if (id !== undefined && id !== null) replyErr(id!, -32603, `internal error: ${e?.message ?? e}`);
  }
}

// ---------- startup ----------

getDb();
const recovery = recoverInterrupted(pidAlive);
if (recovery.cleaned.length > 0) {
  process.stderr.write(`[agent-review-bridge] 重启恢复: ${recovery.cleaned.length} 个未确认请求标记为 interrupted\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: JsonRpcMsg;
  try { msg = JSON.parse(t); } catch { process.stderr.write(`[agent-review-bridge] non-JSON line ignored\n`); return; }
  if (msg.method === undefined) return; // response to a server request — none sent
  if (msg.id === undefined || msg.id === null) {
    // notification: initialized / cancelled / etc.
    if (msg.method === "notifications/cancelled") {
      process.stderr.write(`[agent-review-bridge] cancel notification for ${msg.params?.requestId} (bounded waits end on their own)\n`);
    }
    return;
  }
  void onRequest(msg);
});
rl.on("close", () => process.exit(0));
process.stderr.write(`[agent-review-bridge] ready (pid=${process.pid})\n`);
