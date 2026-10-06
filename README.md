# agent-review-bridge — 本地多 Agent 评审桥

零依赖的本地 MCP 桥:让 **Codex、Claude Code、ZCode** 在各自聊天里互相邀请评审同一方案。主持人(任一工具)通过同一套 MCP 工具调用其他工具的**原生会话**:被邀请者用自己的登录与订阅、工作在同一项目目录;后续追问沿用原会话 ID;答复原样返回。完整规格见 [agent-review-bridge-spec.md](agent-review-bridge-spec.md),实测证据见 [VERIFICATION.md](VERIFICATION.md)。

```
用户当前聊天: Codex / Claude Code / ZCode
                    │ MCP (stdio)
                    ▼
     本地薄桥(node src/server.ts,零 npm 依赖)
         ├─ codex exec / exec resume(原生)
         ├─ claude -p --resume(原生)
         └─ zcode.cjs -p --resume(原生,桌面同款入口)
                    │
        同一项目目录,各自原生会话
```

## 环境要求

- macOS + **Node ≥ 22.5**(需内置 `node:sqlite`;`nvm install 22` 即可)
- 三家已登录:Codex CLI(`codex login`,ChatGPT 订阅)、Claude Code CLI、ZCode 桌面版(已登录订阅)

## 安装

### 人类安装(两条命令)

```sh
git clone https://github.com/Big-Pony/agent-review-bridge.git ~/agent-review-bridge
bash ~/agent-review-bridge/hosts/install.sh        # 自动找 Node、注册三宿主;--remove 卸载
```

已开着的宿主会话需**新开会话**才会加载桥。

### AI 代装指引(把本节直接交给目标机器上的 AI agent 执行)

> 你要在用户这台 macOS 机器上安装 agent-review-bridge。按步骤执行,每步失败就停下来向用户报告,不要猜。

1. **取代码**:`git clone https://github.com/Big-Pony/agent-review-bridge.git ~/agent-review-bridge`(已存在则 `git -C ~/agent-review-bridge pull`)。
2. **检查 Node**(`node:sqlite` 必需):
   ```sh
   node --input-type=module -e 'import("node:sqlite").then(()=>console.log("sqlite OK"),e=>console.log("MISSING:",e.message))'
   ```
   输出 MISSING 时先 `nvm install 22 && nvm use 22`(或安装 Node ≥22.5),再继续。
3. **安装**:`bash ~/agent-review-bridge/hosts/install.sh`。脚本自动寻找支持 sqlite 的 Node,并把桥注册进 `~/.codex/config.toml`、`~/.claude.json`、`~/.zcode/cli/config.json` 三处(幂等,可重复运行)。若某工具本机未安装,脚本会照常注册,该宿主不可用不影响其余两个。
4. **回归检查**(stub 后端,不消耗模型额度,应 38/38 通过):
   ```sh
   node --no-warnings ~/agent-review-bridge/test/run-checks.mjs
   ```
5. **登录预检**(只读,不消耗额度):`codex login status` 应显示 ChatGPT 登录;`claude --version` 可执行;`ls /Applications/ZCode.app` 存在且桌面已登录。任何一家缺失就向用户报告该项不可用,不要静默跳过。
6. **真实冒烟**(消耗少量模型额度,先征得用户同意):在一个临时目录新开任一宿主会话,说"请通过 agent_review_bridge 邀请 codex 评审:<一句话小任务>,拿到答复转述第一行"。若报"未找到 CLI",按提示在桥的宿主 env 里设 `ARB_CODEX_BIN`/`ARB_CLAUDE_BIN` 绝对路径后重试。
7. **收尾**:向用户报告各宿主可用状态与回归结果;提醒新开会话才加载桥,卸载用 `bash hosts/install.sh --remove`。

## 使用

装好后,在**项目目录**里任一工具的**新会话**中用自然语言:

> 请让 Codex 和 Claude Code 评审这个方案:……(方案正文贴在聊天里,或写进文件给路径)。有分歧就让他们继续讨论,最后给我你的判断。

主持人会:邀请参与者 → 同一工作区创建各自原生会话 → 拿原样答复 → 围绕分歧追问 → 汇总判断。过程中可随时说:

| 你说 | 效果 |
|---|---|
| "继续问 Claude 关于 X 的顾虑" | 在 Claude 的同一原生会话追问(上下文保留) |
| "给我打开 Codex 评审会话的命令" | 返回原生恢复入口(codex/claude 为终端命令,ZCode 为桌面入口) |
| "我看完了,继续" | 解除手动接管,继续原会话 |
| "停止讨论" | 停止派发并取消在途请求 |
| "让 GPT 直接跟我的 ZCode 会话 xxx 讨论"(给原生会话 ID) | 导入该会话为参与者(`native_session_id`),后续轮次直接在它上面续聊 |

**导入已有会话的注意**：被导入的会话**当前不能正被对应工具打开**——ZCode/各工具"打开即持有"，持有时桥的 resume 会被拒（zcode 报 `Model creation failed`,桥的失败信息会带此提示）。用法是"乒乓式"：你想看时打开桌面看完就关上，桥的下一轮才能写入；开着围看实时刷新当前版本做不到。

四个 MCP 工具:`agent_invite`(邀请) / `agent_continue`(同会话续聊) / `agent_result`(有界等待取结果,默认 25s 窗口,pending 就用同一 request_id 续等) / `agent_session`(info / handoff / release / cancel)。完整主持规则见 [hosts/HOST_INSTRUCTIONS.md](hosts/HOST_INSTRUCTIONS.md)——建议加入项目的 `AGENTS.md`/`CLAUDE.md`。

## 核心行为

- **同一工作区**:一次讨论绑定一个绝对目录;参与者看到同一工作树的未提交修改与未跟踪文件;续聊不得换目录;桥不向项目写任何文件(数据在 `~/Library/Application Support/agent-review-bridge/`)。
- **各自登录**:Codex 走 ChatGPT 订阅;Claude 使用本机配置(API 路由默认放行,`ARB_REQUIRE_CLAUDE_SUBSCRIPTION=1` 恢复严格模式);ZCode 走桌面已配置的订阅 provider。桥不保存、不改写任何凭据。
- **被邀请者默认最大权限**(避免无头评审因权限确认中断):codex `-s danger-full-access`、claude `--dangerously-skip-permissions`、zcode `--mode yolo`;`ARB_INVITEE_PERMISSIONS=readonly` 恢复只读评审。
- **自我禁用**:被邀请会话按准确工具名禁用本桥 4 个工具(codex 用 `-c` 条目覆盖、claude/zcode 用禁用名单),其他 MCP 不受影响(已实测)——被邀请者不能递归邀请。
- **原 ID 续聊 / 原样答复**:三家均按原生会话 ID 续聊;答复取本轮最终正文,不重放历史、不混入工具输出;超大答复落盘为文件并返回绝对路径。
- **失败与恢复**:pending/busy/failed/cancelled/interrupted 如实返回;每轮由独立 runner 进程执行,宿主重启不中断在途请求;重启后无法确认的请求标记 interrupted 并要求显式 cancel,绝不自动重发。
- **等待模型**:`agent_result` 默认 25 秒窗口(规避 ZCode 桌面 30s 的 MCP 调用硬超时),主持人循环等待;宿主超时宽松时可单次给 `wait_seconds=600` 挂到完成(桥以 MCP progress 通知保活)。

已知限制与实测细节见 [VERIFICATION.md](VERIFICATION.md)(ZCode 桌面包无终端 TUI,手动接管走桌面任务列表;宿主侧 MCP 超时差异等)。

## 目录结构

```
src/server.ts          MCP stdio 服务器(4 工具)
src/runner.ts          每轮独立执行进程(detached,结果写回 SQLite)
src/state.ts           SQLite 状态库(讨论/参与者/请求,WAL 多进程协调)
src/providers/         codex / claude / zcode 接入分支 + bin 解析 + 权限档
hosts/install.sh       一键安装/卸载(三宿主)
hosts/SETUP.md         手动配置与环境变量说明
hosts/HOST_INSTRUCTIONS.md  主持说明(给宿主 agent 读)
test/run-checks.mjs    stub 流程检查(38 项,零额度)
test/real-e2e.mjs      真实链路抽查(消耗少量额度)
agent-review-bridge-spec.md  原始规格
```

## 卸载

```sh
bash ~/agent-review-bridge/hosts/install.sh --remove
```

只移除三宿主里的桥注册;桥数据目录与各工具已保存的原生会话不受影响。
