# 三宿主安装配置

**新机器快捷方式**：把本仓库放到目标机后，直接运行 `bash hosts/install.sh`（自动寻找支持 `node:sqlite` 的 Node、写入下面三处配置、可重复运行）；`bash hosts/install.sh --remove` 一键卸载。以下为各宿主的手动配置说明与细节。

以下 `<BRIDGE>` 代表本仓库绝对路径(示例:`~/agent-review-bridge`),`<NODE>` 代表一个支持 `node:sqlite` 的 Node ≥22 绝对路径(示例:`/Users/<you>/.nvm/versions/node/v22.22.2/bin/node`)。

所有配置都是**局部新增**,不覆盖已有条目;移除方式见各节末尾。

## Codex 宿主

在 `~/.codex/config.toml` 追加:

```toml
[mcp_servers.agent_review_bridge]
command = "<NODE>"
args = ["--no-warnings", "<BRIDGE>/src/server.ts"]
env = { ARB_HOST = "codex" }
```

无头宿主(脚本化)可用进程级覆盖注入,无需改文件:

```sh
codex exec --approve-for-me \
  -c 'mcp_servers.agent_review_bridge.command="<NODE>"' \
  -c 'mcp_servers.agent_review_bridge.args=["--no-warnings","<BRIDGE>/src/server.ts"]' \
  "<主持任务>"
```

说明:MCP 工具调用在 `approval_policy=never` 的非交互模式下会被拒;宿主需要 `--approve-for-me`(自动审批)或在交互 TUI 中人工批准。

主持说明:把 `hosts/HOST_INSTRUCTIONS.md` 的内容(或一行引用 `见 <BRIDGE>/hosts/HOST_INSTRUCTIONS.md`)加入项目 `AGENTS.md`。

移除:删除上述 `[mcp_servers.agent_review_bridge]` 段。

## Claude Code 宿主

```sh
claude mcp add --scope user agent_review_bridge -- <NODE> --no-warnings <BRIDGE>/src/server.ts
```

或直接在 `~/.claude.json` 的 `mcpServers` 中新增:

```json
{
  "mcpServers": {
    "agent_review_bridge": {
      "command": "<NODE>",
      "args": ["--no-warnings", "<BRIDGE>/src/server.ts"],
      "env": {"ARB_HOST": "claude"}
    }
  }
}
```

主持说明:把 `hosts/HOST_INSTRUCTIONS.md` 的内容加入 `~/.claude/CLAUDE.md` 或项目 `CLAUDE.md`。

移除:`claude mcp remove --scope user agent_review_bridge`。

## ZCode 宿主

ZCode 桌面版不把 CLI 放进 PATH;桥直接使用应用内置入口
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`(可用 `ARB_ZCODE_CLI` 覆盖)。

在 `~/.zcode/cli/config.json` 中新增(文件不存在则创建;若已有内容只合并 `mcp.servers` 键):

```json
{
  "mcp": {
    "servers": {
      "agent_review_bridge": {
        "type": "stdio",
        "command": "<NODE>",
        "args": ["--no-warnings", "<BRIDGE>/src/server.ts"],
        "env": {"ARB_HOST": "zcode"}
      }
    }
  }
}
```

移除:删除该 `mcp.servers.agent_review_bridge` 条目(或整个文件,若为此新建)。

## 环境变量(可选)

| 变量 | 默认 | 说明 |
|---|---|---|
| `ARB_DATA_DIR` | `~/Library/Application Support/agent-review-bridge` | 桥状态库/答复缓存/日志目录(不在被评审项目内) |
| `ARB_MAX_INLINE_BYTES` | 65536 | 超过该大小的答复改为文件交付 |
| `ARB_CODEX_BIN` / `ARB_CLAUDE_BIN` / `ARB_ZCODE_CLI` / `ARB_ZCODE_NODE` | 自动发现 | 各后端入口覆盖 |
| `ARB_INVITEE_PERMISSIONS` | `max` | 被邀请者权限:默认最大权限(避免权限确认导致的中断/等待);设 `readonly` 恢复只读评审模式 |
| `ARB_REQUIRE_CLAUDE_SUBSCRIPTION` | 未设置 | 默认放行本机 Claude 的 API 路由配置(用户决定);设 `1` 恢复"仅订阅登录"严格模式(检测到路由即拒绝并说明) |
| `ARB_MCP_SERVER_NAME` | `agent_review_bridge` | 桥在各宿主注册的服务器名(用于被邀请会话的自我禁用) |

**宿主 MCP 调用超时**:实测 ZCode 桌面对单次 MCP 工具调用有 **30 秒硬超时**,因此桥的 `agent_result` 默认等待窗口为 25 秒,到时返回 `pending` 由主持人循环。若你的宿主支持更长调用(如 Claude Code 可通过 `MCP_TOOL_TIMEOUT` 调大),主持人可单次给 `wait_seconds=600`,桥会以进度通知保活。

## 数据目录与清理

```
~/Library/Application Support/agent-review-bridge/
├── state.db          # 讨论/参与者/请求状态(SQLite, WAL)
├── answers/<disc>/<req>.md   # 超大答复原样缓存(保留至手动清理)
└── logs/<req>.log    # 每轮执行日志
```

桥不会向被评审的项目目录写任何文件。卸载桥不影响任何原生工具已保存的会话。
