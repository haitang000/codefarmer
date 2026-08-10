# CodeFarmer

CodeFarmer 是一个模块化 Coding Agent 命令行工具。它能够检查工作区、生成代码、
通过可审查的补丁编辑文件、运行经审批的命令、查看 Git 状态，并恢复历史会话。
它基于 OpenAI Responses API，默认使用 `gpt-5.6-sol` 模型和 `medium` 推理强度。

[English](README.md) | [架构](docs/ARCHITECTURE.md) |
[安全模型](docs/SECURITY.md) | [安装与部署](docs/DEPLOYMENT.md)

> CodeFarmer 使用当前操作系统用户的权限执行本地工具。审批和路径检查不等同于
> 操作系统沙箱。启用 `--approval auto` 前，请先阅读
> [安全模型](docs/SECURITY.md)。

## 技术选型

本项目使用 TypeScript、ESM 和 Node.js 22+。Node.js 对 OpenAI 流式响应和
Windows、macOS、Linux 跨平台进程管理支持成熟，npm 也适合分发全局 CLI；
TypeScript 则可以严格约束 Provider 事件、工具参数、配置和持久化数据。
Commander 负责参数解析，Clack 和 Chalk 负责终端交互，Zod 校验配置，Execa
以参数数组而非模型生成的 shell 字符串启动进程，Pino 记录结构化日志，Vitest
负责测试。

## 环境要求

- Node.js 22 或更高版本
- OpenAI API Key
- Git（可选，供只读的 Git 状态、差异、历史和提交查看工具使用）
- 从源码构建时需要 pnpm

## 安装

安装已发布的 npm 包：

```bash
npm install -g codefarmer
```

在当前 shell 中设置 API Key。CodeFarmer 优先从 `OPENAI_API_KEY` 环境变量
读取密钥；也可以运行 `codefarmer setup` 将密钥保存到用户配置目录下的
本地凭据文件（不会进入项目或配置文件）。

```bash
export OPENAI_API_KEY="sk-..."
```

PowerShell：

```powershell
$env:OPENAI_API_KEY = "sk-..."
```

从本仓库进行开发安装：

```bash
corepack enable
pnpm install
pnpm build
npm install -g .
```

## 快速开始

```bash
cd your-project
codefarmer init
codefarmer
```

在交互式 TTY 中，直接运行 `codefarmer` 会打开全屏 TUI；也可以使用
`codefarmer tui` 或 `codefarmer chat` 显式启动。脚本和 CI 请使用
`run --json`。

`init` 会在当前工作区生成带 JSON Schema 引用的
`codefarmer.config.json`。如需引导式配置，可运行 `codefarmer setup`，
它会交互式询问模型、Base URL、推理强度和审批策略，并可在写入前测试
OpenAI 连接。工作区边界严格等于 `--cwd` 指定的目录，或
CodeFarmer 启动时所在的目录；它不会自动扩大到上层 Git 仓库。

## CLI 命令

| 命令                                            | 用途                                                  |
| ----------------------------------------------- | ----------------------------------------------------- |
| `codefarmer`                                    | 在交互式终端打开全屏 TUI                              |
| `codefarmer tui`                                | 显式打开 TUI                                          |
| `codefarmer init`                               | 创建项目配置文件                                      |
| `codefarmer setup`                              | 交互式向导配置模型、Base URL、推理强度和审批策略      |
| `codefarmer chat`                               | 在 TUI 中启动会话                                     |
| `codefarmer run "<任务>"`                       | 执行一次性任务，可用于脚本和 CI                       |
| `codefarmer status`                             | 显示工作区、Git、有效配置和近期会话状态               |
| `codefarmer undo`                               | 撤销最近一笔仍符合条件的补丁事务                      |
| `codefarmer sessions list`                      | 列出当前工作区的本地会话                              |
| `codefarmer sessions show <id>`                 | 显示会话和审计摘要                                    |
| `codefarmer sessions rename <id> <title>`       | 重命名会话（设置或覆盖标题）                          |
| `codefarmer sessions export <id>`               | 导出会话为 Markdown 或 JSON（`--format`/`--output`）  |
| `codefarmer sessions resume <id>`               | 使用响应 ID 恢复会话                                  |
| `codefarmer sessions delete <id>`               | 删除本地会话记录                                      |
| `codefarmer config list`                        | 显示有效配置                                          |
| `codefarmer config get <key>`                   | 读取一项有效配置                                      |
| `codefarmer config set <key> <value>`           | 写入用户配置                                          |
| `codefarmer config set --project <key> <value>` | 写入项目配置                                          |
| `codefarmer config path`                        | 显示配置文件路径                                      |
| `codefarmer doctor`                             | 检查 Node、密钥、配置、权限、Git（可选）和 API 连通性 |
| `codefarmer completions <shell>`                | 打印 bash、zsh 或 fish 补全脚本                       |

使用 `codefarmer <命令> --help` 查看命令专用参数。全局参数包括：

```text
--cwd <路径>
--model <模型>
--base-url <URL>
--reasoning <auto|none|low|medium|high|xhigh|max>
--approval <ask|auto|read-only>
--no-stream
--log-level <trace|debug|info|warn|error|fatal|silent>
--verbose
--version
--help
```

### 一次性任务和 JSON 输出

`run` 支持 `--json` 和 `--no-history`。JSON 模式只在 stdout 写出一个稳定
结果对象，其中包含 `sessionId`、`status`、`message`、工具摘要、token 用量
和错误信息；诊断日志仍写入 stderr。

```bash
codefarmer --approval read-only run --json "查找可能的空指针错误"
```

在非交互环境中，如果某项操作仍需确认，该操作会以退出码 `3` 失败，CodeFarmer
不会自动代替用户确认。

### 终端 UI

TUI 在同一个备用屏幕中承载对话、工具状态、审批、工作区状态和会话操作。
模型输出会流式显示，修改文件或执行变更命令时会弹出审批框；只有明确按 `y`
才会允许操作。

| TUI 命令       | 操作                                       |
| -------------- | ------------------------------------------ |
| `/help`        | 显示本地命令                               |
| `/init`        | 检查工作区并创建或更新 `AGENT.md`          |
| `/status`      | 显示会话、工作区、Git 和运行状态           |
| `/context`     | 查看当前上下文消息与 Token 用量            |
| `/effort`      | 打开推理强度选择器（↑/↓ 选择，Enter 确认） |
| `/config`      | 显示有效配置                               |
| `/doctor`      | 检查本地运行环境                           |
| `/sessions`    | 列出本地会话                               |
| `/resume <id>` | 切换到已有会话                             |
| `/delete <id>` | 删除非当前会话                             |
| `/diff`        | 显示当前 Git 差异                          |
| `/commit <msg>` | 暂存并提交工作区全部更改                  |
| `/undo`        | 撤销最近一笔符合条件的文件事务             |
| `/new`         | 开始一个新会话                             |
| `/cancel`      | 取消当前请求或工具                         |
| `/quit`        | 退出 TUI 并恢复终端                        |

模型生成期间仍可执行只读斜杠命令、`/cancel` 和 `/quit`；普通提示词会保留在输入框中，
等待当前轮次结束后再提交。

当前请求运行时，按 Esc 或 Ctrl+C 会取消请求或工具并记录会话状态；空闲时按
Ctrl+C 会退出 TUI。非交互 shell 中直接运行命令只显示帮助，不会启动渲染器。

## Agent 工具

首版向模型提供固定工具集：

- `list_files`、`read_file`、`search_text`：检查允许访问的工作区文件。
- `apply_patch`：在核对预期 SHA-256 后创建、修改或删除一个 UTF-8 文件；
  文件写入采用原子替换，并记录可检测冲突的撤销事务。
- `run_command`：只接收可执行文件和参数数组，不接收 shell 字符串。
- `git_status` 和 `git_diff` 显示工作区状态，`git_log` 显示提交历史，`git_show`
  查看单个提交（补丁或 `--stat` 摘要），全部只读、不修改仓库状态。Git 为可选
  依赖：缺失时这些工具会优雅失败，Agent 继续使用文件工具完成任务。


不支持 commit、checkout/switch、reset、clean、merge、rebase、tag、push 等
Git 写操作。工具参数都会校验，输入和输出有大小限制；只读工具可以并行，文件
变更和命令串行执行。Agent 默认最多运行 25 轮。

## 配置

配置优先级由高到低如下：

1. CLI 参数
2. 环境变量
3. 工作区 `codefarmer.config.json`
4. 操作系统用户配置文件
5. 内置默认值

项目配置示例：

```json
{
  "model": "gpt-5.6-sol",
  "baseURL": "https://api.openai.com/v1",
  "reasoning": "medium",
  "approval": "ask",
  "stream": true,
  "store": true,
  "logLevel": "info",
  "maxAgentTurns": 25,
  "maxFileSizeBytes": 1048576,
  "maxToolOutputBytes": 102400,
  "commandTimeoutMs": 120000,
  "ignoredPaths": [".git/**", "node_modules/**", "dist/**", ".env"]
}
```

支持的环境变量如下：

| 配置项               | 环境变量                           | 默认值                      |
| -------------------- | ---------------------------------- | --------------------------- |
| `model`              | `CODEFARMER_MODEL`                 | `gpt-5.6-sol`               |
| `baseURL`            | `CODEFARMER_BASE_URL`              | `https://api.openai.com/v1` |
| `reasoning`          | `CODEFARMER_REASONING`             | `medium`                    |
| `approval`           | `CODEFARMER_APPROVAL`              | `ask`                       |
| `stream`             | `CODEFARMER_STREAM`                | `true`                      |
| `store`              | `CODEFARMER_STORE`                 | `true`（v1 必须）           |
| `logLevel`           | `CODEFARMER_LOG_LEVEL`             | `info`                      |
| `maxAgentTurns`      | `CODEFARMER_MAX_AGENT_TURNS`       | `25`                        |
| `maxFileSizeBytes`   | `CODEFARMER_MAX_FILE_SIZE_BYTES`   | `1048576`                   |
| `maxToolOutputBytes` | `CODEFARMER_MAX_TOOL_OUTPUT_BYTES` | `102400`                    |
| `commandTimeoutMs`   | `CODEFARMER_COMMAND_TIMEOUT_MS`    | `120000`                    |
| `ignoredPaths`       | `CODEFARMER_IGNORED_PATHS`         | 受保护和生成目录            |

`CODEFARMER_IGNORED_PATHS` 可以是 JSON 字符串数组或逗号分隔列表。默认忽略
`.git`、依赖目录、构建与覆盖率输出、`.env`、私钥和证书；`.env.example`
仍允许读取。

可以永久、按项目或仅为一次命令更换 API 端点：

```bash
codefarmer config set baseURL "https://gateway.example/v1"
codefarmer config set baseURL "https://gateway.example/v1" --project
codefarmer --base-url "http://localhost:8080/v1" run "检查当前项目"
```

未设置 `CODEFARMER_BASE_URL` 时，也会读取 `OPENAI_BASE_URL`。URL 必须使用
HTTP(S)，且不能包含账号密码、查询参数或片段；末尾斜杠会自动移除。

## 审批与安全边界

| 策略        | 行为                                                   |
| ----------- | ------------------------------------------------------ |
| `ask`       | 自动读取；文件变更展示 diff 后确认；普通命令执行前确认 |
| `auto`      | 自动执行允许的工作区补丁和普通命令                     |
| `read-only` | 拒绝文件变更和非只读命令                               |

危险系统命令、`sh -c`、`cmd /c`、`powershell -Command` 等 shell 包装绕过，
以及所有 Git 写操作，在任何策略下都会被拒绝。启动子进程前会移除
`OPENAI_API_KEY` 和其他名称疑似包含敏感信息的环境变量。

这些保护属于应用层策略。CodeFarmer v1 **没有**操作系统级进程、文件系统、
容器或网络沙箱，命令产生的副作用也不能通过 `undo` 撤销。建议保留默认的
`ask`，使用版本控制，并在处理不可信代码时放入一次性容器或虚拟机。启用
`auto` 前请阅读 [docs/SECURITY.md](docs/SECURITY.md)。

## 会话、隐私与日志

OpenAI Provider 默认以 `store: true` 使用 Responses API，并通过
`previous_response_id` 恢复后续轮次。发送给模型的提示、选中的代码、工具调用
和结果可能按照 OpenAI API 账户的数据控制策略被远端保留。删除 CodeFarmer
本地会话只会删除本地记录，不会删除 OpenAI 已保留的响应。

CodeFarmer v1 会拒绝 `store: false`。无状态续接需要完整回放推理项和工具项，
本版本不会宣称支持尚未实现的回放模式。

每个会话都会绑定创建时使用的 Base URL。切换端点前应新建会话；CodeFarmer
不会把已有的 `response_id` 发送到另一个服务。

本地会话会保存消息、响应 ID、工具与审计摘要、审批结果、补丁和哈希；撤销快照
可能包含修改前的源码。Pino 按天写入经过脱敏的 JSONL 日志并保留 14 天。
配置、数据和日志使用 `env-paths` 提供的操作系统标准用户目录，并按工作区真实
路径的哈希隔离。

## 错误处理与退出码

默认错误信息简洁并给出可操作建议；`--verbose` 会额外显示堆栈。网络临时故障、
HTTP 429 和 5xx 最多自动重试两次。

| 退出码 | 含义                               |
| ------ | ---------------------------------- |
| `0`    | 成功                               |
| `1`    | Agent、API 或工具失败              |
| `2`    | 参数或配置错误                     |
| `3`    | 用户拒绝审批，或非交互环境无法审批 |
| `4`    | 认证失败                           |
| `130`  | 用户中断                           |

## 开发、测试与发布

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

自动化测试使用可编程 Fake Provider；真实 OpenAI 冒烟测试是可选项，必须显式
提供 `OPENAI_API_KEY`。GitHub Actions 会在 Windows、macOS、Linux 的 Node.js
22 和 24 上执行 lint、类型检查、测试、构建、打包和全局安装冒烟测试。

开发规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。npm 发布、离线 tarball、CI
非交互使用、升级回滚、卸载和本地数据清理步骤见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 许可证

[MIT](LICENSE)
