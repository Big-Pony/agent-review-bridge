#!/usr/bin/env node
// Stub zcode CLI entry for flow checks. Markers in prompt (see stub-codex.sh).
const args = process.argv.slice(2);
let resumed = null;
for (let i = 0; i < args.length; i++) if (args[i] === "--resume") resumed = args[i + 1];
const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] : "";
const marker = (re) => {
  const m = prompt.match(re);
  return m ? m[1] : null;
};
const sidOverride = marker(/#ARBSTUB sid=(\S+)/);
const sid = sidOverride || resumed || "sess_stub-zcode-0001";
const delay = Number(marker(/#ARBSTUB delay=(\d+)/) || 0);
const fail = /#ARBSTUB fail/.test(prompt);
setTimeout(() => {
  const payload = fail
    ? { sessionId: sid, response: "", error: "stub zcode 执行失败" }
    : { sessionId: sid, response: `stub-zcode 答复(${resumed ? "同ID续聊:" + resumed : "新会话"}):收到: ${prompt.slice(0, 60)}` };
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(fail ? 1 : 0);
}, delay * 1000);
