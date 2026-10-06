# 验证结果(规格 9.4 交付证据)

日期:2026-09-13 · 环境:macOS 25.6 (darwin arm64) · Node v22.22.2(nvm,`node:sqlite` 可用)

## 工具版本与实际接入路径

| 工具 | 版本 | 接入路径(实测) |
|---|---|---|
| Codex CLI | 0.153.4(`~/.local/bin/codex`) | `codex exec --json -s read-only -C <dir> -` 创建(prompt 走 stdin);`codex exec resume <id> --json -c 'sandbox_mode="read-only"' -` 续聊(该子命令无 `-s/-C`,经配置覆盖+进程 cwd);`thread.started` 取 ID,最后一个 `agent_message` 为最终答复 |
| Claude Code | 2.1.268(`~/.local/bin/claude`) | `claude -p --output-format json --permission-mode plan --disallowedTools ...`(stdin prompt);`--resume <id>` 续聊;JSON 的 `session_id`/`result` |
| ZCode | 桌面 3.11.2(Info.plist),内置 CLI zcode.cjs 0.16.5(`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`) | `[node, zcode.cjs, -p <prompt>, --cwd <dir>, --mode plan, --disallowed-tools ..., --json]`;`--resume sess_...` 续聊;env 注入桌面订阅 provider(`~/.zcode/v2/config.json` enabled 条目 → `ZCODE_MODEL/ZCODE_BASE_URL/ANTHROPIC_API_KEY`,同 zcode-acp 的接入方式,未引入该第三方组件) |

ZCode 组件记录:评估了 `william0wang/zcode-acp` v0.37.1 源码(仅作协议参考:app-server 会话/resume 参数、runtimeModel overlay、桌面 tasks-index 同步),**未安装、未依赖**;最终采用更少代码的 headless CLI 直连。无第三方运行时依赖。

## V1–V6 原生接入验证(测试项目:`/tmp/arb-verify/Reviewer Play Ground`,含未提交修改、未跟踪文件、路径带空格)

| 编号 | Codex | Claude Code | ZCode |
|---|---|---|---|
| V1 登录来源 | **通过**:auth.json tokens(ChatGPT 订阅);`codex login status` 亦确认;无 OPENAI_API_KEY 冲突 | **通过(按用户决定)**:本机 Claude 为 DeepSeek API 路由(`ANTHROPIC_BASE_URL=api.deepseek.com/anthropic`,modelUsage=deepseek-flash),用户确认为预期配置、默认放行;`ARB_REQUIRE_CLAUDE_SUBSCRIPTION=1` 可恢复严格模式(检测到路由即拒绝,六方向 E2E 中该拒绝行为曾实测生效)。Anthropic 订阅路径本身未验证(本机无该登录) | **通过**:桌面 `~/.zcode/v2/config.json` enabled provider `builtin:bigmodel-coding-plan`(订阅 plan key,coding-plan 登录写入);桥只读取并注入 env,不落盘、不记录 |
| V2 工作区 | **通过**:pwd 正确;读到未提交修改(notes.md)与未跟踪文件;无 worktree/副本 | **通过**(同上) | **通过**(同上,经 `--cwd`) |
| V3 原生续聊 | **通过**:exec resume 同 thread id,回忆暗语与文件内容,无历史重放 | **通过**:`--resume <id>` 同 session_id 回显 | **通过**:CLI `--resume sess_...` 与 app-server 会话同库;另实测 app-server 跨进程 resume+runtimeModel 修复可用(备用路径) |
| V4 原样结果 | **通过**:答复含中文/换行/代码块/行号/γ 多字节;`-o` 与事件流最终消息一致;中间 agent_message 不混入 | **通过**:`result` 字段即最终答复 | **通过**:`response` 字段即最终答复(pretty-printed JSON,桥整体解析) |
| V5 手动恢复 | **通过**(pty 驱动实测):`codex resume <id> "<新暗语>"` 交互续聊→桥同 ID 读回 EAGLE-78 | **通过**:`claude --resume <id>` 交互(信任对话框确认)告知 EAGLE-77→桥同 ID 读回 | **部分通过**:CLI TUI 在桌面 bundle 环境缺 `@zcode/tui` 无法运行(报错原文留存);实测改走桌面应用:CLI/桥创建的会话在桌面共享存储(`~/.zcode/cli/db`),桥同步 tasks-index 后桌面任务列表可定位并继续;桥侧同 ID 读回已由 V3 证明。**桌面 UI 内点开该会话续聊**未做人工确认(避免打扰用户桌面),标注未验证 |
| V6 被邀请者边界 | **桥禁用通过**:`-c ...enabled=false` 后 `codex mcp list` 显示 disabled、其他服务器不受影响,会话内模型确认工具不可调用。**写权限已放开**(2026-09-13 用户决定:被邀请者默认最大权限 `-s danger-full-access`,避免权限中断);`readonly` 模式下的只读拦截此前已实测(touch 报 `Operation not permitted`) | **桥禁用通过**:`--disallowedTools`(4 个准确工具名)后桥工具从会话工具列表完全消失,其他 MCP 保留。**写权限默认放开**(`--dangerously-skip-permissions`,用户决定);`plan` 模式只读行为此前已实测 | **桥禁用通过**:`--disallowed-tools` 后桥 4 工具从列表消失,其他 MCP(4_5v_mcp/node_repl/web_reader)保留。**写权限默认放开**(`--mode yolo`,用户决定);`plan` 模式只读行为此前已实测 |

注:V6 的"其他必要读取工具可用"以工具列表核查为证;codex 沙箱拒绝、claude/zcode 工具列表变化均为客户端实证,非仅模型口头声明。

## 六方向 MCP 端到端(真实宿主经 MCP 调桥;脚本 `test/host-direction.sh`)

| 主持人 | 被邀请者 | 结果 | 摘要 |
|---|---|---|---|
| Codex | Claude Code | **通过** | 两轮答复转述正确;预检先拒 API 路由,经 env 显式放行后通过 |
| Codex | ZCode | **通过** | round1=ok round2 含暗语 BRIDGE-11 |
| Claude Code | Codex | **通过** | 宿主确认两轮同一 native_session_id,暗语正确 |
| Claude Code | ZCode | **通过** | 同上(sess_ 原生 ID 一致) |
| ZCode | Codex | **通过** | round1=ok round2=true |
| ZCode | Claude Code | **通过** | round1=ok round2=true |

每方向含:自然语言触发邀请、同工作区、新建成功、收到原样答复、≥1 次原 ID 追问。"查看原会话→真实入口"以 handoff 命令实测(V5)覆盖。

宿主侧注意(已写入 SETUP.md):codex 无头宿主需 `--approve-for-me`(否则 MCP 调用被 approval_policy=never 拒绝);claude/zcode 宿主不能开 plan 模式(会拦自身 MCP 调用)。

## 9.3 流程检查(stub 后端,`test/run-checks.mjs`):36/36 通过

覆盖:原样结果与重复读取一致、重复邀请不重复执行、跨目录拒绝、并行参与者与失败隔离、4 轮多轮(无两轮硬编码)、有界等待 pending→同 ID 完成、busy 不排队、cancel(含幽灵清理)后可再派发、handoff 忙碌拒绝/引号正确路径/接管期拒派发/release、>100KB 长答复文件完整、桥重启后结果与续聊保留(interrupted 恢复:标记+拒续聊+cancel 后恢复)、zcode 同 ID 续聊与桌面入口。

## 其他运行过的必要检查

- 真实链路抽查 `test/real-e2e.mjs`:codex/zcode/claude 各 5/5(邀请→原样答复→原 ID 续聊→上下文保留)。
- codex MCP 禁用机制对比:`-c mcp_servers.<name>.enabled=false`(单键)会整条目替换导致 `invalid transport`;采用完整内联表条目(或安装时 profile 文件)后仅目标服务器 disabled。
- ZCode 桌面 tasks-index 同步实测:插入 `(workspace_key, task_id)` 行后任务列表可查询到该会话。
- 桥的 SQLite 状态在多宿主进程并发下经 WAL+busy_timeout 协调(stub 检查内含双参与者并行)。

## 未通过/未验证项

1. **Claude 的 Anthropic 订阅登录路径**:本机为 DeepSeek API 路由(用户已确认默认放行);Anthropic 订阅路径本机无登录、未验证。
2. **ZCode 桌面 UI 内人工点开会话续聊**:自动化验证了存储共享与任务列表可见性,未做真实桌面人工操作。
3. **Codex 无头宿主在 `approval_policy=never` 下无法调 MCP**:为 codex exec 的既有行为;安装文档要求宿主用 `--approve-for-me` 或交互批准,非桥缺陷。
4. 桌面版 ZCode 作为宿主(图形界面内直接说自然语言触发)未做人工验证;CLI/headless ZCode 宿主已实测等价路径。

## 测试痕迹说明

验证使用 `/tmp/arb-verify`、`/tmp/arb-e2e` 等临时测试目录;桥自身数据在 `~/Library/Application/agent-review-bridge/`。验证产生的少量原生测试会话分别留在各工具的会话存储中(codex thread `01a09aba-…`、claude session `94ccc5fb-…`、zcode `sess_2d37b760-…` 等,标题均以"你在参与一次只读…/联调"开头,可自行删除);未触碰任何真实项目仓库。证据不含用户真实聊天或鉴权材料。

## 变更记录

- 2026-09-13(用户决定):① 本机 Claude 的 DeepSeek API 路由为预期配置,预检默认放行(原默认拒绝+`ARB_ALLOW_CLAUDE_API_ROUTING` 放行机制改为 `ARB_REQUIRE_CLAUDE_SUBSCRIPTION=1` 严格模式可选);② 被邀请者默认最大权限(codex `-s danger-full-access`、claude `--dangerously-skip-permissions`、zcode `--mode yolo`),避免无头评审因权限确认中断/等待;`ARB_INVITEE_PERMISSIONS=readonly` 恢复只读。改后三家真实链路各 5/5 复测通过(claude 侧同时验证了路由默认放行)。

- 2026-09-13(修复):首次真实使用(ZCode 桌面宿主)暴露 GUI 启动无用户 PATH——`spawn("codex")` ENOENT。新增 `src/providers/resolve.ts`(env 覆盖 → PATH → 已知安装位:~/.local/bin、~/.codex/packages/standalone、~/.local/share/claude/versions、Homebrew、ChatGPT.app bundle),codex/claude 接入;runner 对 spawn 失败给出含修正指引的错误。在 `env -i PATH=/usr/bin:/bin` 模拟 GUI 环境下 codex/claude 真实链路各 5/5 复测通过;stub 36/36 回归通过。

- 2026-09-13(等待体验):① `agent_result` 支持桥侧长等待+MCP progress 保活(上限 900s);② 实测 ZCode 桌面对 MCP 调用有 30s 硬超时(单次 wait=180 被掐断并报 timeout),故默认窗口改为 25s,主持说明改为"pending 循环+长等待可选";③ 评估过"完成后主动推送":MCP 协议下服务器无法向宿主模型注入消息,sampling/elicitation 三家支持不一,均未采用(按用户决定,也不做 macOS 系统通知);等待由主持人的 pending 循环承担。stub 检查 38/38。

- 2026-09-13(导入已有会话):`agent_invite` 新增 `native_session_id`(adopt)——把用户已有的原生会话登记为参与者,首轮直接在其上执行。实测:未被持有时 zcode 会话导入+首轮+上下文保留通过;**持有锁实测**:会话被另一后端进程(含桌面)打开时,外部 CLI/桥 resume 报 `Model creation failed`(桥的错误信息带关闭窗口提示)——"桌面开着围观+桥实时写入"在当前 ZCode 实现下不可行,采用乒乓式(看时关桥派发,派发时关窗口)。stub 40/40。

- 2026-10-07(适配 ZCode 3.14.4):期间桌面自动更新 3.11.2→3.14.4 后,终端/无桌面 env 环境下 zcode CLI 启动即报"无法定位 CLI ZCode Built-in Provider Config"(bundle 内无 provider/ 目录,回退路径不存在)。根因:新版 CLI 依赖桌面注入的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 指向 ~/.zcode/v2 下的实际文件。修复:桥的 env 注入补齐这两项(沿用已有值,否则解析 runtime/provider/<platform>/<version>/ 下实际存在的 active 文件)并附 ZCODE_APP_VERSION。env -i 干净环境(复现 GPT 宿主场景)真实链路 5/5 复测通过;stub 40/40。

- 2026-10-07(3.14.4 已知缺口):修复 env 注入后,**resume 旧版(3.11/3.12 桌面)创建的会话**仍报 `Model creation failed`,verbose 显示 `Cause: Select a model before continuing`。定位:3.14.4 外部启动(CLI/app-server)的 Provider Registry 为空——setModel 报"Provider Registry 中不存在 Model"、session/read 的 model.available=[];新版 setModel 已不接受 runtimeModel overlay;cli/config.json 的 main/available 模型段试验无效。桥新建的会话(带 env provider 快照)resume 正常(干净环境 5/5 复测)。**待验证的绕过**:在 3.14 桌面中打开旧会话并发送一条消息(让桌面以新格式重写模型 selection)后,外部 resume 是否恢复——需用户配合一步;未验证前,旧会话导入建议改用"内容延续"(把旧会话结论作为材料开新会话)。
