#!/bin/bash
# Stub claude backend for flow checks. Markers in prompt (see stub-codex.sh).
set -u
PROMPT="$(cat)"
FLAT="$(printf '%s' "$PROMPT" | tr '\n' ' ')"
SID="stub-claude-0001"
case "$FLAT" in *"#ARBSTUB sid="*) SID="$(printf '%s' "$FLAT" | sed -n 's/.*#ARBSTUB sid=\([^ ]*\).*/\1/p')";; esac
DELAY=0
case "$FLAT" in *" delay="*) DELAY="$(printf '%s' "$FLAT" | sed -n 's/.* delay=\([0-9]*\).*/\1/p')";; esac
[ "$DELAY" -gt 0 ] 2>/dev/null && sleep "$DELAY"
case "$FLAT" in
  *"#ARBSTUB fail"*)
    printf '%s\n' "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"session_id\":\"$SID\",\"result\":\"stub: 额度不足\"}"
    exit 0 ;;
esac
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"$SID\",\"result\":\"stub-claude 答复:收到: $(printf '%s' "$FLAT" | tr '\n' ' ' | cut -c1-60)\"}"
exit 0
