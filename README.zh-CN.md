# CodeFarmer

CodeFarmer 是一个模块化 Coding Agent 命令行工具。它能够检查工作区、生成代码、
通过可审查的补丁编辑文件、运行经审批的命令、查看 Git 状态，并恢复历史会话。
它支持 OpenAI、Google Gemini、xAI Grok、DeepSeek 和 Kimi；OpenAI 默认使用
Responses API 与 `gpt-5.6-sol` 模型。

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
- OpenAI、Google Gemini、xAI Grok、DeepSeek 或 Kimi 的 API Key
- Git（可选，供只读的 Git 状态、差异、历史和提交查看工具使用）
- 从源码构建时需要 pnpm

## 安装

安装已发布的 npm 包：

```bash
npm install -g codefarmer
```

在当前 shell 中设置所选 Provider 的 API Key。运行 `codefarmer setup` 可以选择
Provider、自动填入默认端点和模型，并将密钥保存到用户配置目录下的本地凭据文件
（不会进入项目或配置文件）。

```bash
export OPENAI_API_KEY="sk-..."
```

PowerShell：

```powershell
$env:OPENAI_API_KEY = "sk-..."
```

支持 `OPENAI_API_KEY`、`GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）、
`XAI_API_KEY`（或 `GROK_API_KEY`）、`DEEPSEEK_API_KEY`、
`MOONSHOT_API_KEY`（或 `KIMI_API_KEY`）。使用 setup 时只需填写所选
Provider 的 API Key。

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
codefarmer
```

首次在交互式终端运行时，如果项目和用户配置都不存在，CodeFarmer 会自动启动
`setup` 向导，完成后进入全屏 TUI。仍可使用 `codefarmer init` 创建默认项目配置，
跳过向导。也可以使用 `codefarmer tui` 或 `codefarmer chat` 显式启动 TUI；脚本和
CI 请使用 `run --json`。

全屏会话采用单一工作台模式：任务执行期间可以继续输入后续任务，CodeFarmer
会按顺序排队执行，并在底部显示当前任务与队列状态。文件或命令审批支持
“仅本次 / 本会话 / 当前工作区”授权；工作区授权保存在用户数据目录中，不会
扩大现有工作区边界。`/help` 按会话、工作区、权限和调试分组显示常用命令。

`init` 会在当前工作区生成带 JSON Schema 引用的
`codefarmer.config.json`。如需引导式配置，可运行 `codefarmer setup`，
它会交互式询问 Provider、模型、Base URL、推理强度和审批策略，并可在写入前测试
所选 Provider 连接。工作区边界严格等于 `--cwd` 指定的目录，或
CodeFarmer 启动时所在的目录；它不会自动扩大到上层 Git 仓库。

## CLI 命令

| 命令                                            | 用途                                                      |
| ----------------------------------------------- | --------------------------------------------------------- |
| `codefarmer`                                    | 在交互式终端打开全屏 TUI                                  |
| `codefarmer tui`                                | 显式打开 TUI                                              |
| `codefarmer init`                               | 创建项目配置文件                                          |
| `codefarmer setup`                              | 交互式向导配置模型、Base URL、推理强度和审批策略          |
| `codefarmer chat`                               | 在 TUI 中启动会话                                         |
| `codefarmer run "<任务>"`                       | 执行一次性任务，可用于脚本和 CI；省略任务时从标准输入读取 |
| `codefarmer skills list`                        | 列出发现的 Codex 兼容 skill                               |
| `codefarmer skills show <ref> [path]`           | 显示 skill 或其文本资源                                   |
| `codefarmer status`                             | 显示工作区、Git、有效配置和近期会话状态                   |
| `codefarmer stats`                              | 显示本地会话的 Token 用量与估算费用统计                   |
| `codefarmer undo`                               | 撤销最近一笔仍符合条件的补丁事务                          |
| `codefarmer sessions list`                      | 列出当前工作区的本地会话                                  |
| `codefarmer sessions show <id>`                 | 显示会话和审计摘要                                        |
| `codefarmer sessions rename <id> <title>`       | 重命名会话（设置或覆盖标题）                              |
| `codefarmer sessions compact <id>`              | 压缩长会话：将早期消息折叠为摘要                          |
| `codefarmer sessions export <id>`               | 导出会话为 Markdown 或 JSON（`--format`/`--output`）      |
| `codefarmer sessions resume <id>`               | 使用响应 ID 恢复会话                                      |
| `codefarmer sessions delete <id>`               | 删除本地会话记录                                          |
| `codefarmer config list`                        | 显示有效配置                                              |
| `codefarmer config get <key>`                   | 读取一项有效配置                                          |
| `codefarmer config set <key> <value>`           | 写入用户配置                                              |
| `codefarmer config set --project <key> <value>` | 写入项目配置                                              |
| `codefarmer config path`                        | 显示配置文件路径                                          |
| `codefarmer language [language]`                | 查看或持久化界面和 Agent 回复语言                         |
| `codefarmer doctor`                             | 检查 Node、密钥、配置、权限、Git（可选）和 API 连通性     |
| `codefarmer completions <shell>`                | 打印 bash、zsh 或 fish 补全脚本                           |

使用 `codefarmer <命令> --help` 查看命令专用参数。全局参数包括：

```text
--cwd <路径>
--model <模型>
--base-url <URL>
--language <en|zh-CN>
--reasoning <auto|none|low|medium|high|xhigh|max>
--verbosity <low|medium|high>
--reasoning-summary <none|auto|concise|detailed>
--budget <usd>
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
模型输出会流式显示；使用默认 `ask` 策略时，修改文件或执行变更命令会弹出审批框，
只有明确按 `y` 才会允许操作。

按 `Shift+Tab` 可在 `CODE`、`PLAN` 和 `AUTO` 三种模式间循环切换。`PLAN`
只进行只读探索并输出实施计划；`AUTO` 会根据 prompt 自动列出计划，随后直接实施和验证，
普通工作区操作无需人工审批。`git push` 等受保护操作仍需显式确认。也可以使用
`/plan [on|off]` 和 `/auto [on|off]` 直接选择模式。

| TUI 命令         | 操作                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `/help`          | 显示本地命令                                                        |
| `/init`          | 检查工作区并创建或更新 `AGENT.md`                                   |
| `/status`        | 显示会话、工作区、Git 和运行状态                                    |
| `/context`       | 查看当前上下文消息与 Token 用量                                     |
| `/compact`       | 把当前会话的早期消息压缩为摘要（长会话时自动提示）                  |
| `/effort`        | 打开推理强度选择器（↑/↓ 选择，Enter 确认）                          |
| `/plan [on/off]` | 开启或关闭只读计划模式                                              |
| `/auto [on/off]` | 开启或关闭自动计划并执行模式                                        |
| `/language [en   | zh-CN]`                                                             | 切换界面和 Agent 回复语言（保存为默认语言，之后会话继承） |
| `/config`        | 显示有效配置                                                        |
| `/doctor`        | 检查本地运行环境                                                    |
| `/sessions`      | 打开本地会话选择器（`↑/↓` 选择，Enter 切换，Esc 关闭）              |
| `/resume <id>`   | 切换到已有会话                                                      |
| `/retry`         | 重新执行上一条提示词（例如切换模型或模式后重试）                    |
| `/delete <id>`   | 删除非当前会话                                                      |
| `/diff`          | 彩色显示当前 Git 差异（新增、删除、文件头和区块范围）               |
| `/review`        | 只读审查工作区差异（含已暂存与未暂存），不提交                      |
| `/security-review [PATH...]` | 审查差异中的安全漏洞，按严重程度排序；可选路径聚焦审查范围 |
| `/commit [msg]`  | 暂存并提交工作区全部更改；不提供信息时由 agent 总结差异生成提交信息 |
| `/push`          | 确认后将当前分支推送到已配置的上游                                  |
| `/undo`          | 撤销最近一笔符合条件的文件事务                                      |
| `/todos`         | 显示 Agent 当前任务清单（由 `todo_write` 工具维护）                 |
| `/new`           | 开始一个新会话                                                      |
| `/cancel`        | 取消当前请求或工具                                                  |
| `/quit`          | 退出 TUI 并恢复终端                                                 |

模型生成期间仍可执行只读斜杠命令、`/cancel` 和 `/quit`；普通提示词会保留在输入框中，
等待当前轮次结束后再提交。

当前请求运行时，按 Esc 或 Ctrl+C 会取消请求或工具并记录会话状态；空闲时按
Ctrl+C 会退出 TUI。非交互 shell 中直接运行命令只显示帮助，不会启动渲染器。

## Agent 工具

首版向模型提供固定工具集：

- `list_files`、`read_file`、`search_text`：检查允许访问的工作区文件。
- `apply_patch`：在核对预期 SHA-256 后创建、修改或删除 UTF-8 文件；一次调用
  可批量修改多个文件，每个文件写入均为原子替换，并记录可检测冲突的撤销事务。
- `run_command`：只接收可执行文件和参数数组，不接收 shell 字符串。
- `web_fetch`：抓取 HTTP(S) URL 并返回文本内容，限制响应大小与时间；默认阻止
  私有、回环和链路本地地址，避免仓库内容把 Agent 变成内网扫描器。
- `web_search`：通过 DuckDuckGo 搜索网页并返回标题、URL 和摘要；用它发现页面，
  再用 `web_fetch` 读取完整内容。
- `todo_write`：维护会话内的任务清单，配合多步骤任务使用；TUI 中用 `/todos` 查看。
- `git_status` 和 `git_diff` 显示工作区状态，`git_log` 显示提交历史，`git_show`
  查看单个提交（补丁或 `--stat` 摘要），全部只读、不修改仓库状态。Git 为可选
  依赖：缺失时这些工具会优雅失败，Agent 继续使用文件工具完成任务。

不支持 commit、checkout/switch、reset、clean、merge、rebase、tag 等 Git 写
操作。Agent 只能通过 `run_command` 执行 `git push`，且无论审批策略为何，均须
由用户明确确认完整命令。工具参数都会校验，输入和输出有大小限制；只读工具可以并行，文件
变更和命令串行执行。Agent 默认最多运行 12 轮。

## Skills

CodeFarmer 支持与 Codex 兼容的 skill：skill 是包含 `SKILL.md` 的目录，文件 frontmatter
需要提供 `name` 和 `description`。程序从工作区向上扫描 `.agents/skills`，随后扫描用户和
系统目录；同时兼容 `$CODEX_HOME/skills` 与 `~/.codex/skills`。可使用
`codefarmer skills list`、`codefarmer skills show <ref>`、`codefarmer run --skill <ref> "任务"`；
TUI 提供 `/skills`、`/skill <ref>` 和 `/skill off`。

初始 instructions 只包含紧凑的技能目录；Agent 需要时通过只读 `read_skill` 读取完整 skill，
并可通过 `read_skill_resource` 读取其目录中的 UTF-8 资源。同名 skill 不会合并，目录会提供带
scope 的引用。技能及其资源都属于不可信指令，不能绕过审批、路径或命令限制；skill 脚本绝不会
被隐式执行，任何执行仍必须经过 `run_command` 的正常安全检查和审批。

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
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "baseURL": "https://api.openai.com/v1",
  "reasoning": "high",
  "verbosity": "low",
  "reasoningSummary": "none",
  "approval": "ask",
  "stream": true,
  "store": true,
  "logLevel": "info",
  "maxAgentTurns": 12,
  "maxFileSizeBytes": 1048576,
  "maxToolOutputBytes": 12288,
  "commandTimeoutMs": 120000,
  "autoCompact": false,
  "autoCompactMinMessages": 40,
  "autoCompactMinChars": 100000,
  "budgetUsd": 2.5,
  "ignoredPaths": [".git/**", "node_modules/**", "dist/**", ".env"]
}
```

支持的环境变量如下：

| 配置项                   | 环境变量                               | 默认值                      |
| ------------------------ | -------------------------------------- | --------------------------- |
| `provider`               | `CODEFARMER_PROVIDER`                  | `openai`                    |
| `model`                  | `CODEFARMER_MODEL`                     | `gpt-5.6-sol`               |
| `baseURL`                | `CODEFARMER_BASE_URL`                  | `https://api.openai.com/v1` |
| `reasoning`              | `CODEFARMER_REASONING`                 | `high`                      |
| `language`               | `CODEFARMER_LANGUAGE`                  | `en`                        |
| `verbosity`              | `CODEFARMER_VERBOSITY`                 | `low`                       |
| `reasoningSummary`       | `CODEFARMER_REASONING_SUMMARY`         | `none`                      |
| `approval`               | `CODEFARMER_APPROVAL`                  | `ask`                       |
| `stream`                 | `CODEFARMER_STREAM`                    | `true`                      |
| `store`                  | `CODEFARMER_STORE`                     | `true`（v1 必须）           |
| `logLevel`               | `CODEFARMER_LOG_LEVEL`                 | `info`                      |
| `maxAgentTurns`          | `CODEFARMER_MAX_AGENT_TURNS`           | `12`                        |
| `maxFileSizeBytes`       | `CODEFARMER_MAX_FILE_SIZE_BYTES`       | `1048576`                   |
| `maxToolOutputBytes`     | `CODEFARMER_MAX_TOOL_OUTPUT_BYTES`     | `12288`                     |
| `commandTimeoutMs`       | `CODEFARMER_COMMAND_TIMEOUT_MS`        | `120000`                    |
| `autoCompact`            | `CODEFARMER_AUTO_COMPACT`              | `false`                     |
| `autoCompactMinMessages` | `CODEFARMER_AUTO_COMPACT_MIN_MESSAGES` | `40`                        |
| `autoCompactMinChars`    | `CODEFARMER_AUTO_COMPACT_MIN_CHARS`    | `100000`                    |
| `budgetUsd`              | `CODEFARMER_BUDGET_USD`                | 关闭                        |
| `ignoredPaths`           | `CODEFARMER_IGNORED_PATHS`             | 受保护和生成目录            |

`CODEFARMER_IGNORED_PATHS` 可以是 JSON 字符串数组或逗号分隔列表。默认忽略
`.git`、依赖目录、构建与覆盖率输出、`.env`、私钥和证书；`.env.example`
仍允许读取。

`autoCompact`（默认关闭）会在会话达到 `autoCompactMinMessages` 条消息或
`autoCompactMinChars` 字符后，在下一轮开始前自动把早期消息压缩为摘要，
并保留最近几轮逐字内容。每次自动压缩会产生一次额外的摘要请求；手动
执行 `/compact` 也可获得相同效果。

`budgetUsd`（默认关闭）设置会话的成本上限（美元），使用与 `stats` 相同的
公开列表价估算。当会话累计估算成本达到预算后，新一轮任务会被拒绝并返回
`BUDGET_EXCEEDED` 错误，直到调高预算或 `/new` 开始新会话；跨越阈值的那一轮
仍会正常完成。可通过 `--budget <usd>`、`CODEFARMER_BUDGET_USD` 或配置项
`budgetUsd` 设置。

## Provider

可通过 `--provider`、`CODEFARMER_PROVIDER`、setup 向导或配置文件选择
`openai`、`gemini`、`grok`、`deepseek` 或 `kimi`。OpenAI 使用 Responses API；
Gemini、Grok、DeepSeek 和 Kimi 使用官方 OpenAI Chat Completions 兼容端点，
并通过本地显式回放会话历史来继续工具调用。setup 会自动填入各 Provider 的默认
模型和端点；只有需要覆盖默认值时才设置 `model` 和 `baseURL`。

```bash
codefarmer --provider deepseek run "审查当前仓库"
codefarmer config set provider gemini --project
codefarmer setup
```

推理强度默认使用 `high`，以应对复杂任务；其余默认值偏向节省 token：低详细度正文、
不生成可见推理摘要、每次模型请求最多 2048 个完成 token、最多 12 个工具轮次，以及每个
工具输出最多 12 KiB。任务简单或 token 预算紧张时可将 `reasoning` 调低（例如 `low` 或
`none`）；需要更多容量时，可以提高 `verbosity`、`reasoningSummary`、
`maxAgentTurns` 或 `maxToolOutputBytes`。

如果模型在生成正文前耗尽全部输出预算，CodeFarmer 会直接给出明确错误，不会静默修改已配置的
推理强度或详细度。请降低 `reasoning` 后重试；已有部分
正文时会直接保留并提示内容可能不完整。

DeepSeek 流式响应按官方 SSE 约定处理保活注释和 `[DONE]` 终止标记。连接掉线或响应截断会被
识别为可恢复的临时错误，当前 agent 轮次会使用指数退避最多重放三次，截断内容不会被误判为
成功完成。思考模式下的工具调用也会在后续请求中完整带回 DeepSeek 要求的
`reasoning_content`。

对 DeepSeek 而言，`maxAgentTurns` 是软检查点，不再是到达后立即停止的硬限制。长任务达到配置
的工具轮次后，CodeFarmer 会分段自动扩展预算，继续使用现有上下文执行，最多到 100 轮安全上限；
其他 Provider 仍严格遵守配置的轮次限制。

可以永久、按项目或仅为一次命令更换 API 端点：

```bash
codefarmer config set baseURL "https://gateway.example/v1"
codefarmer config set baseURL "https://gateway.example/v1" --project
codefarmer --base-url "http://localhost:8080/v1" run "检查当前项目"
```

未设置 `CODEFARMER_BASE_URL` 时，也会读取 `OPENAI_BASE_URL`。URL 必须使用
HTTP(S)，且不能包含账号密码、查询参数或片段；末尾斜杠会自动移除。

### 自定义 OpenAI 兼容端点

`provider` 也支持直接内联一个自定义端点对象（用户或项目配置）。端点内的
`model` 和 `baseURL` 作为该 Provider 的默认值；顶层 `model`/`baseURL` 或
`--model`/`--base-url` 仍可覆盖。`apiKeyEnv` 指定保存 API Key 的环境变量；
未设置时依次检查 `CODEFARMER_API_KEY` 与本地凭据文件。本地免密钥服务
（Ollama、vLLM、LM Studio 等）可设置 `apiKeyOptional: true` 跳过密钥检查。
端点 `id` 缺省时取 `baseURL` 的主机名（如 `localhost`），且不能与内置
Provider 重名。

```json
{
  "provider": {
    "label": "Local Ollama",
    "baseURL": "http://localhost:11434/v1",
    "model": "llama3.2",
    "apiKeyOptional": true
  }
}
```

```bash
codefarmer config set provider '{"baseURL":"http://localhost:11434/v1","model":"llama3.2","apiKeyOptional":true}' --project
codefarmer --provider localhost run "解释这个 diff"
```

多个可复用端点仍可声明在 `customEndpoints` 数组中，并通过 `provider` 引用
其 `id`：

```json
{
  "provider": "ollama",
  "customEndpoints": [
    {
      "id": "ollama",
      "label": "Local Ollama",
      "baseURL": "http://localhost:11434/v1",
      "model": "llama3.2",
      "apiKeyOptional": true
    }
  ]
}
```

自定义端点与 Gemini、Grok、DeepSeek、Kimi、OpenCode Go 共用同一套 OpenAI 兼容适配器，
会出现在 `setup` 的 Provider 选择列表中，也可通过
`codefarmer config set provider <id>` 切换。

`setup` 也可以直接添加新的自定义端点（在 Provider 列表中选择“添加自定义端点”），
端点会保存到 `customEndpoints`，让多个 Provider 同时存在、随时切换。重复运行
`setup` 会合并到现有项目配置——已保存的端点与其他设置都会保留。

## 审批与安全边界

| 策略        | 行为                                                    |
| ----------- | ------------------------------------------------------- |
| `ask`       | 自动读取；文件变更展示 diff 后确认；普通命令执行前确认  |
| `auto`      | 自动执行允许的工作区补丁和普通命令；`git push` 仍须确认 |
| `read-only` | 拒绝文件变更和非只读命令                                |

危险系统命令、`sh -c`、`cmd /c`、`powershell -Command` 等 shell 包装绕过，
以及除经明确确认的 `git push` 外的所有 Git 写操作，在任何策略下都会被拒绝。启动子进程前会移除
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

首轮对话完成后，模型会根据会话内容自动生成简短标题；生成失败时保留首条
消息标题作为回退，`sessions rename` 设置的自定义标题始终优先。

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
