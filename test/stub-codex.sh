#!/bin/bash
# Stub codex backend for flow checks. Behaviour markers are embedded in the
# prompt itself (single bridge server instance, per-request control):
#   #ARBSTUB delay=8     sleep N seconds before answering
#   #ARBSTUB fail        turn.failed + exit 1
#   #ARBSTUB big         >100KB final message
#   #ARBSTUB rounds=4    needs 4 rounds before final summary (state per session)
#   #ARBSTUB sid=ID  use ID as thread id (default stub-thread-0001)
# Resume form `exec resume <ID>` echoes the SAME id in thread.started.
set -u
if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then
  echo "Logged in using ChatGPT"
  exit 0
fi

PROMPT="$(cat)"
FLAT="$(printf '%s' "$PROMPT" | tr '\n' ' ')"

SID="stub-thread-0001"
case "$FLAT" in *"#ARBSTUB sid="*) SID="$(printf '%s' "$FLAT" | sed -n 's/.*#ARBSTUB sid=\([^ ]*\).*/\1/p')";; esac

RESUMED_ID=""
if [ "${1:-}" = "exec" ] && [ "${2:-}" = "resume" ]; then
  RESUMED_ID="$3"
  SID="$3"
fi

DELAY=0
case "$FLAT" in *" delay="*) DELAY="$(printf '%s' "$FLAT" | sed -n 's/.* delay=\([0-9]*\).*/\1/p')";; esac
[ "$DELAY" -gt 0 ] 2>/dev/null && sleep "$DELAY"

emit() { printf '%s\n' "$1"; }
SNIP="$(printf '%s' "$FLAT" | tr '\n' ' ' | cut -c1-60)"
emit "{\"type\":\"thread.started\",\"thread_id\":\"$SID\"}"

case "$FLAT" in
  *"#ARBSTUB fail"*)
    emit '{"type":"turn.failed","error":{"message":"stub 额度不足/执行失败"}}'
    exit 1 ;;
esac

case "$FLAT" in
  *" big"*)
    BIG="$(head -c 120000 /dev/zero | tr '\0' '长')"
    emit "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"${BIG} (end-of-big-answer)\"}}"
    exit 0 ;;
esac

case "$FLAT" in
  *" rounds="*)
    NEEDED="$(printf '%s' "$FLAT" | sed -n 's/.* rounds=\([0-9]*\).*/\1/p')"
    if [ -n "${STUB_STATE_DIR:-}" ]; then
      mkdir -p "$STUB_STATE_DIR"
      CF="$STUB_STATE_DIR/$SID.count"
      N="$(cat "$CF" 2>/dev/null || echo 0)"; N=$((N+1)); echo "$N" > "$CF"
      if [ "$N" -lt "$NEEDED" ]; then
        emit "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"第 $N 轮:仍缺证据,继续追问(还差 $((NEEDED-N)) 轮)。收到新问题: $SNIP\"}}"
        exit 0
      fi
    fi
    emit '{"type":"item.completed","item":{"type":"agent_message","text":"最终汇总:信息充分,本轮结束。"}}'
    exit 0 ;;
esac

emit '{"type":"item.completed","item":{"type":"agent_message","text":"中间陈述(非最终)。"}}'
emit "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"最终答复${RESUMED_ID:+(续聊:$RESUMED_ID)}:收到任务: $SNIP\"}}"
exit 0
