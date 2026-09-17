#!/bin/bash
# agent-review-bridge 一键安装/卸载(新机器)
# 用法:
#   bash hosts/install.sh            # 安装到三宿主(codex/claude/zcode)
#   bash hosts/install.sh --remove   # 从三宿主移除
#
# 前置: macOS + Node >= 22.5(node:sqlite) + 已登录的 codex/claude CLI + ZCode 桌面版
set -u

BRIDGE="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$BRIDGE/src/server.ts"
NAME="agent_review_bridge"
MODE="install"
[ "${1:-}" = "--remove" ] && MODE="remove"

say() { printf '\033[1;32m[arb]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[arb]\033[1;33m %s\033[0m\n' "$*"; }

# ---------- 1) 解析一个可用的 Node ----------
find_node() {
  for cand in "$(command -v node || true)" \
              "$HOME/.nvm/versions/node/"v22*/bin/node \
              "$HOME/.nvm/versions/node/"v2[3-9]*/bin/node \
              /opt/homebrew/bin/node /usr/local/bin/node \
              "$HOME/.bun/bin/node"; do
    [ -x "$cand" ] || continue
    if "$cand" -e 'require("node:sqlite")' >/dev/null 2>&1 || \
       "$cand" --input-type=module -e 'import("node:sqlite")' >/dev/null 2>&1; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

if [ "$MODE" = "install" ]; then
  NODE_BIN="$(find_node | head -1 || true)"
  if [ -z "$NODE_BIN" ]; then
    warn "未找到支持 node:sqlite 的 Node(>=22.5)。请先安装(nvm install 22)后重试。"
    exit 1
  fi
  say "Node: $NODE_BIN ($("$NODE_BIN" --version))"
  say "桥:   $SERVER"
fi

# ---------- 2) Codex ----------
install_codex() {
  local f="$HOME/.codex/config.toml"
  mkdir -p "$HOME/.codex"
  touch "$f"
  if grep -q "mcp_servers.$NAME" "$f"; then
    say "codex: 已存在配置段(跳过;如需更新路径请手动编辑 $f)"
  else
    cat >> "$f" <<EOF

# agent-review-bridge (local MCP; remove this block to uninstall)
[mcp_servers.$NAME]
command = "$NODE_BIN"
args = ["--no-warnings", "$SERVER"]
env = { ARB_HOST = "codex" }
EOF
    say "codex: 已追加配置到 $f"
  fi
}
remove_codex() {
  local f="$HOME/.codex/config.toml"
  if [ -f "$f" ] && grep -q "mcp_servers.$NAME" "$f"; then
    # 逐行按段删除:定位桥段(及其标记注释行),删到下一个段头为止。
    # 不用正则——`args = [...]` 里的 `[` 会让字符级模式提前截断,残留键破坏邻段。
    python3 - "$f" <<'PYEOF'
import sys
p = sys.argv[1]
lines = open(p).read().split("\n")
out, i, n = [], 0, len(lines)
while i < n:
    l = lines[i].strip()
    if l.startswith("# agent-review-bridge (local MCP"):
        i += 1
        continue
    if l == "[mcp_servers.agent_review_bridge]":
        i += 1
        while i < n:
            nxt = lines[i].strip()
            if nxt.startswith("[") and nxt.endswith("]"):
                break
            i += 1
        while out and out[-1].strip() == "":
            out.pop()
        continue
    out.append(lines[i])
    i += 1
open(p, "w").write("\n".join(out))
PYEOF
    say "codex: 已移除配置段"
  else
    say "codex: 无配置(跳过)"
  fi
}

# ---------- 3) Claude Code ----------
install_claude() {
  python3 - "$NODE_BIN" "$SERVER" <<'EOF'
import json, os, sys
node, server, name = sys.argv[1], sys.argv[2], "agent_review_bridge"
p = os.path.expanduser("~/.claude.json")
try:
    d = json.load(open(p))
except FileNotFoundError:
    d = {}
except Exception as e:
    print(f"[arb] claude: 无法解析 {p}({e}),跳过"); sys.exit(0)
servers = d.setdefault("mcpServers", {})
if name in servers:
    print("[arb] claude: 已存在(跳过)")
else:
    servers[name] = {"command": node, "args": ["--no-warnings", server], "env": {"ARB_HOST": "claude"}}
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    print(f"[arb] claude: 已写入 {p}")
EOF
}
remove_claude() {
  python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.claude.json")
try:
    d = json.load(open(p))
except Exception:
    print("[arb] claude: 无配置(跳过)"); raise SystemExit
if d.get("mcpServers", {}).pop("agent_review_bridge", None) is not None:
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    print("[arb] claude: 已移除")
else:
    print("[arb] claude: 无配置(跳过)")
EOF
}

# ---------- 4) ZCode ----------
install_zcode() {
  python3 - "$NODE_BIN" "$SERVER" <<'EOF'
import json, os, sys
node, server, name = sys.argv[1], sys.argv[2], "agent_review_bridge"
p = os.path.expanduser("~/.zcode/cli/config.json")
os.makedirs(os.path.dirname(p), exist_ok=True)
try:
    d = json.load(open(p))
except FileNotFoundError:
    d = {}
except Exception as e:
    print(f"[arb] zcode: 无法解析 {p}({e}),跳过"); sys.exit(0)
servers = d.setdefault("mcp", {}).setdefault("servers", {})
if name in servers:
    print("[arb] zcode: 已存在(跳过)")
else:
    servers[name] = {"type": "stdio", "command": node, "args": ["--no-warnings", server], "env": {"ARB_HOST": "zcode"}}
    json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    print(f"[arb] zcode: 已写入 {p}")
EOF
}
remove_zcode() {
  python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.zcode/cli/config.json")
try:
    d = json.load(open(p))
except Exception:
    print("[arb] zcode: 无配置(跳过)"); raise SystemExit
servers = d.get("mcp", {}).get("servers", {})
if servers.pop("agent_review_bridge", None) is not None:
    if not d["mcp"]["servers"] and set(d.keys()) == {"mcp"}:
        os.remove(p)  # 为桥新建的空文件 → 直接删除
    else:
        json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
    print("[arb] zcode: 已移除")
else:
    print("[arb] zcode: 无配置(跳过)")
EOF
}

# ---------- 执行 ----------
for fn in codex claude zcode; do
  "${MODE}_${fn}"
done

# ---------- 提示 ----------
if [ "$MODE" = "install" ]; then
  echo
  say "安装完成。可选检查:"
  echo "  node --no-warnings $BRIDGE/test/run-checks.mjs   # stub 回归(不耗模型额度)"
  echo "  已开着的宿主会话需新开会话才会加载桥。"
  echo "  主持说明: hosts/HOST_INSTRUCTIONS.md(建议加入项目的 AGENTS.md/CLAUDE.md)。"
else
  say "卸载完成。桥数据目录 ~/Library/Application Support/agent-review-bridge 与原生会话不受影响,可手动删除前者。"
fi
