#!/usr/bin/env node
/**
 * 9.3 流程检查 — stub 后端驱动的端到端检查。
 * 覆盖: 多轮/软停止材料、有界等待 pending、同会话串行 busy、并行参与者、
 * 手动接管、失败与取消、重启恢复、interrupted 恢复、长答复文件、路径引号。
 *
 * 运行: node test/run-checks.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const tmp = mkdtempSync(path.join(os.tmpdir(), "arb-checks-"));

// ---------- fixtures ----------
const dataDir = path.join(tmp, "data");
const homeDir = path.join(tmp, "home");
mkdirSync(path.join(homeDir, ".zcode", "v2"), { recursive: true });
writeFileSync(
  path.join(homeDir, ".zcode", "v2", "config.json"),
  JSON.stringify({
    provider: {
      "builtin:stub-plan": {
        enabled: true,
        kind: "anthropic",
        options: { baseURL: "https://stub.example/api/anthropic", apiKey: "stub-plan-key" },
        models: { "GLM-STUB": { limit: { context: 100000, output: 4096 } } },
      },
    },
  }),
);
mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
writeFileSync(path.join(homeDir, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "stub" }, last_refresh: "2026-09-13T00:00:00Z" }));
const ws = path.join(tmp, "Work Space'Q"); // space + single quote
mkdirSync(ws, { recursive: true });

chmodSync(path.join(ROOT, "test", "stub-codex.sh"), 0o755);
chmodSync(path.join(ROOT, "test", "stub-claude.sh"), 0o755);

const serverEnv = {
  ...process.env,
  HOME: homeDir, // zcode provider config fixture (os.homedir respects $HOME)
  ARB_DATA_DIR: dataDir,
  ARB_CODEX_BIN: path.join(ROOT, "test", "stub-codex.sh"),
  ARB_CLAUDE_BIN: path.join(ROOT, "test", "stub-claude.sh"),
  ARB_ZCODE_CLI: path.join(ROOT, "test", "stub-zcode.cjs"),
  ARB_ZCODE_NODE: NODE,
  ARB_MCP_SERVER_NAME: "agent_review_bridge",
  ARB_BRIDGE_COMMAND: NODE,
  ARB_BRIDGE_ARG0: path.join(ROOT, "src", "server.ts"),
  ARB_HOST: "checks",
  STUB_STATE_DIR: path.join(tmp, "stubstate"),
};
mkdirSync(serverEnv.STUB_STATE_DIR, { recursive: true });

// ---------- MCP client ----------
let proc = null;
let msgId = 0;
const pendingRes = new Map();
const notifications = [];
const progressNotes = [];
function startServer() {
  proc = spawn(NODE, ["--no-warnings", path.join(ROOT, "src", "server.ts")], {
    env: serverEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.id !== null && pendingRes.has(m.id)) {
        pendingRes.get(m.id)(m);
        pendingRes.delete(m.id);
      } else if (m.method) { notifications.push(m); if (m.method === "notifications/progress") progressNotes.push(m); }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  return rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "checks" } }).then(() => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });
}
function rpc(method, params, timeoutMs = 90000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingRes.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
    pendingRes.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function call(name, args) {
  const resp = await rpc("tools/call", { name, arguments: args });
  if (resp.error) throw new Error(`tool ${name} error: ${resp.error.message}`);
  const text = resp.result?.content?.[0]?.text;
  if (resp.result?.isError) throw Object.assign(new Error(`tool ${name} returned error payload: ${text}`), { payload: JSON.parse(text) });
  return JSON.parse(text);
}

// ---------- assertions ----------
let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- checks ----------
await startServer();
console.log("== 基础邀请与原样结果 ==");
let inv = await call("agent_invite", { agent: "codex", workspace: ws, prompt: "评审任务 A:请给出意见。" });
check("invite 返回三 ID", !!inv.discussion_id && !!inv.participant_id && !!inv.request_id && inv.status === "running", JSON.stringify(inv).slice(0, 200));
let res = await call("agent_result", { request_id: inv.request_id, wait_seconds: 20 });
check("首轮完成且答复为最终答复(非中间陈述)", res.status === "completed" && res.answer.startsWith("最终答复"), JSON.stringify(res).slice(0, 200));
check("返回原生会话 ID", typeof res.native_session_id === "string" && res.native_session_id.length > 0);
const res2 = await call("agent_result", { request_id: inv.request_id, wait_seconds: 0 });
check("同请求重复读取结果一致", res2.status === "completed" && res2.answer === res.answer);

console.log("== 重复邀请同工具 ==");
const again = await call("agent_invite", { agent: "codex", workspace: ws, prompt: "不应执行的新任务", discussion_id: inv.discussion_id });
check("重复邀请返回已有参与者且不执行", again.status === "already_participating" && again.participant_id === inv.participant_id && !again.request_id, JSON.stringify(again).slice(0, 200));

console.log("== 工作区一致性 ==");
// 换目录加入已有讨论必须报错
const otherDir = path.join(tmp, "Other Dir");
mkdirSync(otherDir, { recursive: true });
const mismatch = await call("agent_invite", { agent: "claude", workspace: otherDir, prompt: "x", discussion_id: inv.discussion_id }).catch((e) => e.payload ?? { error: "no-error" });
check("跨目录加入已有讨论被拒绝", typeof mismatch.error === "string" && mismatch.error.includes("不一致"), JSON.stringify(mismatch).slice(0, 200));

console.log("== 并行参与者与独立结果/失败隔离 ==");
const c1 = await call("agent_invite", { agent: "claude", workspace: ws, prompt: "评审任务 B(并行)。", discussion_id: inv.discussion_id });
const z1 = await call("agent_invite", { agent: "zcode", workspace: ws, prompt: "#ARBSTUB fail\n评审任务 C(会失败)。", discussion_id: inv.discussion_id });
const rB = await call("agent_result", { request_id: c1.request_id, wait_seconds: 20 });
const rC = await call("agent_result", { request_id: z1.request_id, wait_seconds: 20 });
check("claude 参与者独立完成", rB.status === "completed" && rB.answer.includes("stub-claude"));
check("zcode 失败返回明确原因", rC.status === "failed" && typeof rC.error === "string" && rC.error.length > 0, JSON.stringify(rC).slice(0, 200));
check("一个失败不丢弃另一个结果", rB.status === "completed");

console.log("== 多轮(>=4)续聊,无写死两轮 ==");
const multi = await call("agent_invite", { agent: "codex", workspace: ws, prompt: "#ARBSTUB sid=stub-multi-9 rounds=4\n第 1 轮任务。" });
const r1 = await call("agent_result", { request_id: multi.request_id, wait_seconds: 20 });
let last = r1;
let roundsDone = 1;
for (let i = 2; i <= 4; i++) {
  const cont = await call("agent_continue", { participant_id: multi.participant_id, prompt: `#ARBSTUB sid=stub-multi-9 rounds=4\n第 ${i} 轮追问。` });
  check(`第 ${i} 轮续聊被受理`, cont.status === "running" && !!cont.request_id, JSON.stringify(cont).slice(0, 150));
  last = await call("agent_result", { request_id: cont.request_id, wait_seconds: 20 });
  roundsDone = i;
}
check("第 4 轮后得到汇总答复", last.status === "completed" && last.answer.includes("最终汇总"), last.answer?.slice(0, 80) ?? JSON.stringify(last).slice(0, 120));

console.log("== 有界等待 pending ==");
const slowInv = await call("agent_invite", { agent: "codex", workspace: ws, prompt: "#ARBSTUB sid=stub-slow-1 delay=8\n慢任务。" });
const pend = await call("agent_result", { request_id: slowInv.request_id, wait_seconds: 1 });
check("等待窗口到时返回 pending", pend.status === "running" && typeof pend.note === "string" && pend.note.includes("pending"), JSON.stringify(pend).slice(0, 200));
const done = await call("agent_result", { request_id: slowInv.request_id, wait_seconds: 25 });
check("继续等同一 request 后完成(未新建会话)", done.status === "completed" && done.native_session_id === "stub-slow-1", JSON.stringify(done).slice(0, 200));

console.log("== 单次长等待(桥侧挂起,非轮询) ==");
const longInv = await call("agent_invite", { agent: "codex", workspace: ws, prompt: "#ARBSTUB sid=stub-longwait delay=25\n长任务。" });
const longRes = await rpc("tools/call", { name: "agent_result", arguments: { request_id: longInv.request_id, wait_seconds: 60, _meta: { progressToken: "pt-1" } } });
const longPayload = JSON.parse(longRes.result.content[0].text);
check("单次调用等到完成(未返回 pending)", longPayload.status === "completed" && longPayload.answer.includes("最终答复"), JSON.stringify(longPayload).slice(0, 150));
check("等待期间收到 progress 保活通知", progressNotes.length > 0 && progressNotes.some(n => n.params?.progressToken === "pt-1"), `progress=${progressNotes.length}`);

console.log("== 同会话串行 busy ==");
const busyInv = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "#ARBSTUB sid=stub-slow-1 delay=10\n运行中再续聊应 busy。" });
// busyInv 应为 busy(上一轮 delay=8 可能已完成——用新一轮制造运行态)
let busy;
if (busyInv.status === "running") {
  busy = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "并发续聊" });
} else {
  const rerun = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "#ARBSTUB sid=stub-slow-1 delay=10\n制造运行态。" });
  busy = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "并发续聊" });
  await call("agent_result", { request_id: rerun.request_id, wait_seconds: 25 });
}
// 无论哪条分支,等 busyInv 那一轮真正结束,再进入取消段
if (busyInv.request_id) await call("agent_result", { request_id: busyInv.request_id, wait_seconds: 25 });
check("运行中续聊返回 busy 不排队", busy.status === "busy", JSON.stringify(busy).slice(0, 200));

console.log("== 取消 ==");
const cancelInv = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "#ARBSTUB sid=stub-slow-1 delay=30\n待取消。" });
check("待取消请求在运行", cancelInv.status === "running");
const cancelled = await call("agent_session", { participant_id: slowInv.participant_id, action: "cancel" });
check("cancel 后请求状态 cancelled 且参与者空闲", cancelled.cancelled_request?.status === "cancelled" && cancelled.status === "idle", JSON.stringify(cancelled).slice(0, 250));
const afterCancel = await call("agent_result", { request_id: cancelInv.request_id, wait_seconds: 2 });
check("被取消请求读取为 cancelled", afterCancel.status === "cancelled");
const resumeAfter = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "#ARBSTUB sid=stub-slow-1\n取消后可再派发。" });
check("取消后可再次派发", resumeAfter.status === "running");
await call("agent_result", { request_id: resumeAfter.request_id, wait_seconds: 25 });

console.log("== 手动接管 ==");
const hoRunning = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "#ARBSTUB sid=stub-slow-1 delay=15\n接管前的运行态。" });
const hoBusy = await call("agent_session", { participant_id: slowInv.participant_id, action: "handoff" });
check("忙碌时 handoff 报告 busy 且无入口", hoBusy.status === "busy" && !hoBusy.open_with, JSON.stringify(hoBusy).slice(0, 200));
await call("agent_result", { request_id: hoRunning.request_id, wait_seconds: 25 });
const ho = await call("agent_session", { participant_id: slowInv.participant_id, action: "handoff" });
const wsReal = realpathSync(ws);
const expectCd = `cd '${wsReal.replace(/'/g, `'\\''`)}' && codex resume 'stub-slow-1'`;
check("handoff 返回真实恢复命令(引号正确)", ho.status === "handoff" && ho.open_with === expectCd, `${ho.open_with} != ${expectCd}`);
const duringHo = await call("agent_continue", { participant_id: slowInv.participant_id, prompt: "接管期间派发应被拒。" });
check("接管期间拒绝派发", duringHo.status === "handoff", JSON.stringify(duringHo).slice(0, 200));
const rel = await call("agent_session", { participant_id: slowInv.participant_id, action: "release" });
check("release 交回后恢复空闲", rel.status === "idle");

console.log("== 长答复文件 ==");
const bigInv = await call("agent_invite", { agent: "codex", workspace: ws, prompt: "#ARBSTUB sid=stub-big-1 big\n长答复任务。" });
const bigRes = await call("agent_result", { request_id: bigInv.request_id, wait_seconds: 30 });
check("长答复走文件且提示明确", bigRes.status === "completed" && typeof bigRes.answer_file === "string" && !bigRes.answer, JSON.stringify(bigRes).slice(0, 200));
if (bigRes.answer_file && existsSync(bigRes.answer_file)) {
  const content = readFileSync(bigRes.answer_file, "utf8");
  check("文件内容完整(>100KB 且以标记结尾)", content.length > 100000 && content.endsWith("(end-of-big-answer)"), `len=${content.length}`);
}

console.log("== 重启恢复 ==");
const beforeRestart = await call("agent_continue", { participant_id: multi.participant_id, prompt: "#ARBSTUB sid=stub-multi-9\n重启前的最后一轮。" });
const beforeRes = await call("agent_result", { request_id: beforeRestart.request_id, wait_seconds: 25 });
proc.kill("SIGKILL");
await sleep(500);
await startServer();
const afterRes = await call("agent_result", { request_id: beforeRestart.request_id, wait_seconds: 5 });
check("重启后已完成结果仍可读且一致", afterRes.status === "completed" && afterRes.answer === beforeRes.answer);
const contAfterRestart = await call("agent_continue", { participant_id: multi.participant_id, prompt: "#ARBSTUB sid=stub-multi-9\n重启后按原 ID 续聊。" });
check("重启后可按原参与者续聊", contAfterRestart.status === "running");
const cr = await call("agent_result", { request_id: contAfterRestart.request_id, wait_seconds: 25 });
check("重启后续聊成功且沿用同原生 ID", cr.status === "completed" && cr.native_session_id === "stub-multi-9", JSON.stringify(cr).slice(0, 200));

console.log("== interrupted 恢复(无法确认的执行不当作空闲) ==");
// 直接向状态库注入一条 running 且进程已死的请求
{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "state.db"));
  const p = db.prepare("SELECT * FROM participants WHERE agent='codex' AND native_session_id='stub-multi-9'").get();
  db.prepare(
    "INSERT INTO requests(id, participant_id, status, started_at, runner_pid, backend_pid) VALUES(?,?,?,?,?,?)",
  ).run("req_ghost_1", p.id, "running", Date.now(), 999999001, 999999002);
  db.prepare("UPDATE participants SET status='running' WHERE id=?").run(p.id);
  db.close();
}
proc.kill("SIGKILL");
await sleep(500);
await startServer();
const ghost = await call("agent_result", { request_id: "req_ghost_1", wait_seconds: 2 });
check("幽灵请求重启后被标记 interrupted", ghost.status === "interrupted", JSON.stringify(ghost).slice(0, 250));
const ghostCont = await call("agent_continue", { participant_id: ghost.participant_id, prompt: "不应直接续聊。" }).catch((e) => e.payload ?? { error: "?" });
check("interrupted 后续聊被拒并提示先 cancel", typeof ghostCont.error === "string" && ghostCont.error.includes("cancel"), JSON.stringify(ghostCont).slice(0, 250));
const ghostClean = await call("agent_session", { participant_id: ghost.participant_id, action: "cancel" });
check("cancel 清理幽灵占用", ghostClean.status === "idle");
const ghostAfter = await call("agent_continue", { participant_id: ghost.participant_id, prompt: "#ARBSTUB sid=stub-multi-9\n清理后续聊恢复。" });
check("清理后可继续", ghostAfter.status === "running");
await call("agent_result", { request_id: ghostAfter.request_id, wait_seconds: 25 });

console.log("== zcode 接续与 handoff 形态 ==");
const zinv = await call("agent_invite", { agent: "zcode", workspace: ws, prompt: "zcode 首轮任务。" });
const zres = await call("agent_result", { request_id: zinv.request_id, wait_seconds: 20 });
check("zcode stub 首轮完成", zres.status === "completed" && zres.answer.includes("新会话"), JSON.stringify(zres).slice(0, 200));
const zcont = await call("agent_continue", { participant_id: zinv.participant_id, prompt: "zcode 续聊任务。" });
const zres2 = await call("agent_result", { request_id: zcont.request_id, wait_seconds: 20 });
check("zcode 同 ID 续聊(stub 确认 resume)", zres2.status === "completed" && zres2.answer.includes("同ID续聊") && zres2.native_session_id === zres.native_session_id);
const zho = await call("agent_session", { participant_id: zinv.participant_id, action: "handoff" });
check("zcode handoff 给出桌面打开入口", zho.status === "handoff" && zho.open_with.startsWith("open ") && zho.open_with.includes("zcode://workspace/open?path="), zho.open_with);

proc.kill();
console.log(`\n结果: ${passed} passed, ${failed} failed (tmp=${tmp})`);
if (failed === 0 && process.env.KEEP_ARB_TMP !== "1") {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
}
process.exit(failed === 0 ? 0 : 1);
