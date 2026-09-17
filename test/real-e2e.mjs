#!/usr/bin/env node
/**
 * 真实后端端到端检查(消耗少量模型额度):
 *   codex: invite → result → continue(同 thread id resume) → result
 *   zcode: invite → result (真实订阅 provider)
 *   claude: invite → result (用户已配置的 API 路由,需显式放行)
 * 运行: node test/real-e2e.mjs [codex|claude|zcode|all]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const which = process.argv[2] || "all";
const tmp = mkdtempSync(path.join(os.tmpdir(), "arb-real-"));
const ws = path.join(tmp, "Real WS");
mkdirSync(ws, { recursive: true });

const serverEnv = {
  ...process.env,
  ARB_DATA_DIR: path.join(tmp, "data"),
  ARB_MCP_SERVER_NAME: "agent_review_bridge",
  ARB_HOST: "real-e2e",
  ARB_ALLOW_CLAUDE_API_ROUTING: "1",
  PATH: process.env.PATH + ":" + path.join(process.env.HOME, ".local/bin"),
};

let proc, msgId = 0;
const pending = new Map();
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); rej(new Error("rpc timeout " + method)); }, 120000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  if (!text) throw new Error(`no text for ${name}: ` + JSON.stringify(r).slice(0, 200));
  return JSON.parse(text);
}
let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) { passed++; console.log("  PASS", n); } else { failed++; console.log("  FAIL", n, d); } };

proc = spawn(NODE, ["--no-warnings", path.join(ROOT, "src", "server.ts")], { env: serverEnv, stdio: ["pipe", "pipe", "inherit"] });
proc.stdout.on("data", (d) => {
  let buf = (proc.__buf ||= "") + d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
  proc.__buf = buf;
});
await rpc("initialize", { protocolVersion: "2025-06-18" });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

async function waitDone(requestId, maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const r = await call("agent_result", { request_id: requestId, wait_seconds: 20 });
    if (r.status !== "running") return r;
  }
  return { status: "timeout" };
}

async function round(agent) {
  console.log(`== ${agent} 真实链路 ==`);
  const p1 = `你在参与只读评审联调。请记住暗语 PANDA-5。然后用一句话确认你已就绪,并报告当前工作目录(运行 pwd)。`;
  const inv = await call("agent_invite", { agent, workspace: ws, prompt: p1 });
  check("invite 启动", inv.status === "running", JSON.stringify(inv).slice(0, 200));
  const r1 = await waitDone(inv.request_id, 240);
  check("首轮完成", r1.status === "completed" && (r1.answer ?? "").includes("PANDA-5") === false ? r1.status === "completed" : r1.status === "completed", JSON.stringify(r1).slice(0, 300));
  console.log("  首轮答复片段:", (r1.answer ?? r1.error ?? "").slice(0, 120).replace(/\n/g, " "));
  const sid = r1.native_session_id ?? inv.native_session_id;
  check("返回原生会话 ID", typeof sid === "string" && sid.length > 0, String(sid));
  const cont = await call("agent_continue", { participant_id: inv.participant_id, prompt: "只回答:我最初让你记住的暗语短语是什么?" });
  check("续聊启动", cont.status === "running", JSON.stringify(cont).slice(0, 200));
  const r2 = await waitDone(cont.request_id, 240);
  check("续聊完成且上下文保留", r2.status === "completed" && (r2.answer ?? "").includes("PANDA-5"), JSON.stringify(r2).slice(0, 300));
  console.log("  续聊答复片段:", (r2.answer ?? "").slice(0, 80).replace(/\n/g, " "));
}

if (which === "all" || which === "codex") await round("codex");
if (which === "all" || which === "zcode") await round("zcode");
if (which === "all" || which === "claude") await round("claude");

proc.kill();
console.log(`\n真实链路: ${passed} passed, ${failed} failed (tmp=${tmp})`);
if (failed === 0 && process.env.KEEP_ARB_TMP !== "1") { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
process.exit(failed ? 1 : 0);
