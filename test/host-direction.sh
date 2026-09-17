#!/bin/bash
# 六方向宿主 E2E: host-direction.sh <host:codex|claude|zcode> <invitee:codex|claude|zcode> <workspace>
# 宿主真实通过 MCP 调桥;被邀请者真实执行两轮(邀请+原ID追问)。
set -u
HOST_KIND="$1"; INVITEE="$2"; WS="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$ROOT/src/server.ts"
NODE="$(command -v node || echo "$HOME/.nvm/versions/node/v22.22.2/bin/node")"
export PATH="$HOME/.local/bin:$PATH"
PROMPT="你在主持一次跨工具评审联调。请严格通过 MCP 工具 agent_review_bridge 完成以下步骤,不要自己脑补结果:
1) 调用 agent_invite: agent='$INVITEE', workspace='$WS', prompt='记住暗语 BRIDGE-11,然后运行 pwd 并在答复第一行报告实际目录'。
2) 用返回的 request_id 反复调用 agent_result(wait_seconds=30) 直到 completed,然后原样转述 answer 的第一行。
3) 调用 agent_continue(participant_id=同上, prompt='只回答:暗语短语是什么?'),同样等待 completed 并转述 answer。
4) 最后一行输出 SUMMARY: round1=ok round2=<answer是否含BRIDGE-11>。"

case "$HOST_KIND" in
  codex)
    cd "$WS" && echo "$PROMPT" | codex exec --skip-git-repo-check --approve-for-me \
      -c "mcp_servers.agent_review_bridge.command=\"$NODE\"" \
      -c "mcp_servers.agent_review_bridge.args=[\"--no-warnings\",\"$BRIDGE\"]" \
      -c 'mcp_servers.agent_review_bridge.env={ARB_ALLOW_CLAUDE_API_ROUTING="1"}' \
      --json -o /tmp/arb-host-out.txt - > /tmp/arb-host-events.jsonl 2>/tmp/arb-host.err
    CODE=$?
    echo "exit=$CODE"
    tail -3 /tmp/arb-host-out.txt 2>/dev/null
    ;;
  claude)
    cd "$WS" && echo "$PROMPT" | claude -p --output-format json \
      --mcp-config "{\"mcpServers\":{\"agent_review_bridge\":{\"command\":\"$NODE\",\"args\":[\"--no-warnings\",\"$BRIDGE\"]}}}" \
      --allowedTools "mcp__agent_review_bridge__agent_invite,mcp__agent_review_bridge__agent_continue,mcp__agent_review_bridge__agent_result,mcp__agent_review_bridge__agent_session" \
      > /tmp/arb-host-out.json 2>/tmp/arb-host.err
    CODE=$?
    echo "exit=$CODE"
    python3 -c "import json;d=json.load(open('/tmp/arb-host-out.json'));print((d.get('result') or '')[-500:])" 2>/dev/null || cat /tmp/arb-host-out.json | tail -5
    ;;
  zcode)
    export ZCODE_MODEL=GLM-5.3
    export ZCODE_BASE_URL=$(python3 -c "import json;print(next(p for p in json.load(open('$HOME/.zcode/v2/config.json'))['provider'].values() if p.get('enabled'))['options']['baseURL'])")
    export ANTHROPIC_API_KEY=$(python3 -c "import json;print(next(p for p in json.load(open('$HOME/.zcode/v2/config.json'))['provider'].values() if p.get('enabled'))['options']['apiKey'])")
    cd "$WS" && "$NODE" /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs -p "$PROMPT" --cwd "$WS" --mode yolo --json > /tmp/arb-host-out.json 2>/tmp/arb-host.err
    CODE=$?
    echo "exit=$CODE"
    python3 -c "import json;d=json.load(open('/tmp/arb-host-out.json'));print((d.get('response') or '')[-500:])" 2>/dev/null || tail -5 /tmp/arb-host-out.json
    ;;
esac
