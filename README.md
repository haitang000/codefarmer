# CodeFarmer

CodeFarmer is a modular coding-agent CLI that can inspect a workspace, generate
and edit code through reviewable patches, run approved commands, inspect Git,
and resume prior sessions. It supports OpenAI, Google Gemini, xAI Grok,
DeepSeek, and Kimi; OpenAI defaults to the Responses API with `gpt-5.6-sol`.

[简体中文](README.zh-CN.md) | [Architecture](docs/ARCHITECTURE.md) |
[Security](docs/SECURITY.md) | [Deployment](docs/DEPLOYMENT.md)

> CodeFarmer executes local tools with your user account. Its approval and path
> checks are not an operating-system sandbox. Review the
> [security model](docs/SECURITY.md) before using `--approval auto`.

## Why this stack

CodeFarmer uses TypeScript, ESM, and Node.js 22+. Node has mature OpenAI
streaming and cross-platform process APIs, npm provides a simple global CLI
distribution path, and TypeScript gives provider events, tool parameters,
configuration, and persisted records checked interfaces. Commander handles
arguments, Clack and Chalk drive terminal interaction, Zod validates config,
Execa launches processes without model-supplied shell strings, Pino writes
structured logs, and Vitest covers the runtime.

## Requirements

- Node.js 22 or newer
- An API key for OpenAI, Google Gemini, xAI Grok, DeepSeek, or Kimi
- Git (optional) for read-only Git status, diff, log, and show tools
- pnpm when building from source

## Install

Install the published package globally:

```bash
npm install -g codefarmer
```

Set the key for your selected provider in the current shell. `codefarmer setup`
can select a provider, fill its default endpoint and model, and save the key to
a local credential file in your user configuration directory (never inside the
project or configuration files).

```bash
export OPENAI_API_KEY="sk-..."
```

PowerShell:

```powershell
$env:OPENAI_API_KEY = "sk-..."
```

`OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `XAI_API_KEY` (or
`GROK_API_KEY`), `DEEPSEEK_API_KEY`, and `MOONSHOT_API_KEY` (or `KIMI_API_KEY`)
are supported. The setup wizard is the shortest path: it only asks for the
chosen provider's API key.

For development from this repository:

```bash
corepack enable
pnpm install
pnpm build
npm install -g .
```

## Quick start

```bash
cd your-project
codefarmer init
codefarmer
```

When attached to a TTY, `codefarmer` opens the full-screen terminal UI. The
same UI is available explicitly with `codefarmer tui` or `codefarmer chat`.
Use `run --json` for one-shot automation and CI.

The full-screen session uses a single-workbench model: you can type follow-up
tasks while a turn is running and CodeFarmer executes them serially from a
bounded in-memory queue. File and command approvals support one-time, current
session, and current workspace grants. Workspace grants are stored under the
user data directory and never expand the workspace boundary.

`init` creates `codefarmer.config.json` in the current workspace with a JSON
Schema reference. Prefer a guided flow? `codefarmer setup` walks through
provider, model, Base URL, reasoning effort, and approval policy interactively,
and can test the selected provider connection before writing the file. The workspace boundary is
exactly the `--cwd` value, or the
directory in which CodeFarmer starts; it is not automatically expanded to a
parent Git repository.

## Commands

| Command                                         | Purpose                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `codefarmer`                                    | Open the full-screen TUI in an interactive terminal                      |
| `codefarmer tui`                                | Open the TUI explicitly                                                  |
| `codefarmer init`                               | Create a project configuration file                                      |
| `codefarmer setup`                              | Interactive wizard for model, Base URL, reasoning, and approval          |
| `codefarmer chat`                               | Open a TUI session (optionally with `--session`)                         |
| `codefarmer run "<task>"`                       | Run one task, suitable for scripts and CI                                |
| `codefarmer skills list`                        | List discovered Codex-compatible skills                                  |
| `codefarmer skills show <ref> [path]`           | Print a skill or one of its text resources                               |
| `codefarmer status`                             | Show workspace, Git, configuration, and recent-session status            |
| `codefarmer stats`                              | Show aggregate token usage and estimated cost across local sessions      |
| `codefarmer undo`                               | Revert the latest eligible patch transaction                             |
| `codefarmer sessions list`                      | List saved sessions for the workspace                                    |
| `codefarmer sessions show <id>`                 | Show a saved session and audit summary                                   |
| `codefarmer sessions rename <id> <title>`       | Rename a saved session (set or override its title)                       |
| `codefarmer sessions compact <id>`              | Compress a long session: fold early messages into a summary              |
| `codefarmer sessions export <id>`               | Export a session as Markdown or JSON (`--format`/`--output`)             |
| `codefarmer sessions resume <id>`               | Resume a session using its response ID                                   |
| `codefarmer sessions delete <id>`               | Delete local session records                                             |
| `codefarmer config list`                        | Print effective configuration                                            |
| `codefarmer config get <key>`                   | Read one effective setting                                               |
| `codefarmer config set <key> <value>`           | Write a user setting                                                     |
| `codefarmer config set --project <key> <value>` | Write a project setting                                                  |
| `codefarmer config path`                        | Print the configuration path                                             |
| `codefarmer language [language]`                | Show or persist the interface and agent response language                |
| `codefarmer doctor`                             | Check Node, key, config, permissions, optional Git, and API connectivity |
| `codefarmer completions <shell>`                | Print a bash, zsh, or fish completion script                             |

Use `codefarmer <command> --help` for command-specific arguments. Global
options include:

```text
--cwd <path>
--model <model>
--base-url <url>
--language <en|zh-CN>
--reasoning <auto|none|low|medium|high|xhigh|max>
--verbosity <low|medium|high>
--reasoning-summary <none|auto|concise|detailed>
--approval <ask|auto|read-only>
--no-stream
--log-level <trace|debug|info|warn|error|fatal|silent>
--verbose
--version
--help
```

### One-shot and JSON output

`run` accepts `--json` and `--no-history`. JSON mode reserves stdout for one
stable result object containing `sessionId`, `status`, `message`, tool summary,
token usage, and error data. Diagnostics remain on stderr.

```bash
codefarmer --approval read-only run --json "Find likely null dereferences"
```

In a non-interactive environment, an action that still requires confirmation
fails with exit code `3`; it is never implicitly accepted.

### Terminal UI

The TUI keeps the conversation, tool lifecycle, approvals, workspace state, and
session actions in one alternate-screen interface. It streams model output and
shows each tool as it moves from running to succeeded or failed. Mutating tools
pause in an approval modal under the default `ask` policy; only an explicit `y`
accepts the operation.

Press `Shift+Tab` to cycle through `CODE`, `PLAN`, and `AUTO`. `PLAN` is
read-only and stops after producing an implementation plan. `AUTO` derives a
plan from the prompt, then implements and validates it while automatically
approving ordinary workspace operations. Protected operations such as
`git push` still require explicit confirmation. The same modes can be selected
with `/plan [on|off]` and `/auto [on|off]`.

| TUI command      | Action                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `/help`          | Show local commands                                                                        |
| `/init`          | Inspect the workspace and create or update `AGENT.md`                                      |
| `/status`        | Show session, workspace, Git, and runtime                                                  |
| `/context`       | Show context messages and token usage                                                      |
| `/compact`       | Compress early messages of the current session into a summary (suggested on long sessions) |
| `/effort`        | Open the reasoning effort picker (↑/↓ + Enter)                                             |
| `/plan [on/off]` | Enable or disable read-only planning mode                                                  |
| `/auto [on/off]` | Enable or disable automatic plan-and-execute mode                                          |
| `/language [en   | zh-CN]`                                                                                    | Switch the interface and agent response language for the current TUI session |
| `/config`        | Show effective configuration                                                               |
| `/sessions`      | List saved sessions                                                                        |
| `/resume <id>`   | Switch to a saved session                                                                  |
| `/delete <id>`   | Delete a non-active local session                                                          |
| `/diff`          | Show current Git diff with colored additions, removals, headers, and hunks                 |
| `/commit [msg]`  | Stage and commit all workspace changes; without a message the agent summarizes the diff    |
| `/push`          | Push the current branch to its configured upstream after confirmation                      |
| `/undo`          | Undo the most recent eligible file mutation                                                |
| `/new`           | Start a fresh session                                                                      |
| `/cancel`        | Cancel the active request or tool                                                          |
| `/quit`          | Leave the TUI and restore the terminal                                                     |

Read-only slash commands, `/cancel`, and `/quit` remain available while the
model is generating; ordinary prompts stay in the input buffer until it is
ready for the next turn.

`Esc` or `Ctrl+C` cancels an active turn. When no turn is active, `Ctrl+C`
exits and restores the terminal. In a non-interactive shell, no-argument
invocation prints help instead of starting a renderer.

## Agent tools

CodeFarmer exposes a fixed v1 tool set to the model:

- `list_files`, `read_file`, and `search_text` inspect allowed workspace files.
- `apply_patch` creates, modifies, or deletes one UTF-8 file after checking its
  expected SHA-256 hash. Writes are atomic and recorded for conflict-aware
  undo.
- `run_command` accepts an executable and argument array, never a shell string.
- `git_status` and `git_diff` show the working-tree state, `git_log` shows
  commit history, and `git_show` displays individual commits (patch or `--stat`
  summary), all without changing repository state. Git is optional: when it is
  missing, these tools fail gracefully and the agent continues with the file
  tools.

Git writes such as commit, checkout/switch, reset, clean, merge, rebase, and tag
are not supported. The agent may run `git push` through `run_command` only after
the user explicitly confirms the exact command, including when approval is set to
`auto`. Tool input and output are bounded, model tool
arguments are validated, read-only calls may run concurrently, and mutations
and commands run serially. The default agent limit is 12 turns.

## Skills

CodeFarmer supports Codex-compatible skills: a skill is a directory containing a `SKILL.md` file
with `name` and `description` frontmatter. It discovers `.agents/skills` from the workspace up to
the filesystem root, then user and system locations; `$CODEX_HOME/skills` and `~/.codex/skills`
are also supported for compatibility. Use `codefarmer skills list`, `codefarmer skills show <ref>`,
or `codefarmer run --skill <ref> "task"`; in the TUI use `/skills`, `/skill <ref>`, and `/skill off`.

Only a compact catalog is added to the initial model instructions. The agent reads a full skill with
the read-only `read_skill` tool when needed, and can read UTF-8 resources inside that skill with
`read_skill_resource`. Duplicate names remain separate and receive scoped references in the catalog.
Skills and their resources are untrusted instructions and cannot override approval, path, or command
restrictions. Skill scripts are never run implicitly; any execution still goes through `run_command`
and its normal approval and safety checks.

## Configuration

Configuration uses this precedence, with the first source winning:

1. CLI options
2. environment variables
3. workspace `codefarmer.config.json`
4. the platform user configuration file
5. built-in defaults

Example project configuration:

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
  "maxOutputTokens": 2048,
  "maxFileSizeBytes": 1048576,
  "maxToolOutputBytes": 12288,
  "commandTimeoutMs": 120000,
  "autoCompact": false,
  "autoCompactMinMessages": 40,
  "autoCompactMinChars": 100000,
  "ignoredPaths": [".git/**", "node_modules/**", "dist/**", ".env"]
}
```

Supported environment overrides are:

| Configuration key    | Environment variable               | Default                       |
| -------------------- | ---------------------------------- | ----------------------------- |
| `provider`           | `CODEFARMER_PROVIDER`              | `openai`                      |
| `model`              | `CODEFARMER_MODEL`                 | `gpt-5.6-sol`                 |
| `baseURL`            | `CODEFARMER_BASE_URL`              | `https://api.openai.com/v1`   |
| `reasoning`          | `CODEFARMER_REASONING`             | `high`                        |
| `language`           | `CODEFARMER_LANGUAGE`              | `en`                          |
| `verbosity`          | `CODEFARMER_VERBOSITY`             | `low`                         |
| `reasoningSummary`   | `CODEFARMER_REASONING_SUMMARY`     | `none`                        |
| `approval`           | `CODEFARMER_APPROVAL`              | `ask`                         |
| `stream`             | `CODEFARMER_STREAM`                | `true`                        |
| `store`              | `CODEFARMER_STORE`                 | `true` (required in v1)       |
| `logLevel`           | `CODEFARMER_LOG_LEVEL`             | `info`                        |
| `maxAgentTurns`      | `CODEFARMER_MAX_AGENT_TURNS`       | `12`                          |
| `maxOutputTokens`    | `CODEFARMER_MAX_OUTPUT_TOKENS`     | `2048`                        |
| `maxFileSizeBytes`   | `CODEFARMER_MAX_FILE_SIZE_BYTES`   | `1048576`                     |
| `maxToolOutputBytes` | `CODEFARMER_MAX_TOOL_OUTPUT_BYTES` | `12288`                       |
| `commandTimeoutMs`   | `CODEFARMER_COMMAND_TIMEOUT_MS`    | `120000`                      |
| `autoCompact`        | `CODEFARMER_AUTO_COMPACT`          | `false`                       |
| `autoCompactMinMessages` | `CODEFARMER_AUTO_COMPACT_MIN_MESSAGES` | `40`                      |
| `autoCompactMinChars` | `CODEFARMER_AUTO_COMPACT_MIN_CHARS` | `100000`                     |
| `ignoredPaths`       | `CODEFARMER_IGNORED_PATHS`         | protected and generated paths |

`CODEFARMER_IGNORED_PATHS` accepts a JSON string array or a comma-separated
list. Default exclusions cover `.git`, dependencies, builds, coverage, `.env`
files, private keys, and certificates; `.env.example` remains readable.

`autoCompact` (off by default) automatically compresses a long session into a
summary before a turn once the conversation reaches `autoCompactMinMessages`
messages or `autoCompactMinChars` characters of stored content, keeping the
last few turns verbatim. Each auto-compaction costs one extra summarising
request; run `/compact` manually for the same behaviour.

## Providers

Choose `openai`, `gemini`, `grok`, `deepseek`, or `kimi` with `--provider`,
`CODEFARMER_PROVIDER`, the setup wizard, or configuration. OpenAI uses the
Responses API. Gemini, Grok, DeepSeek, and Kimi use their official OpenAI
Chat Completions-compatible endpoints with explicit local conversation replay
for tool calls and session continuation. Provider defaults are selected by
`setup`; use `model` and `baseURL` only to override them.

```bash
codefarmer --provider deepseek run "review this repository"
codefarmer config set provider gemini --project
codefarmer setup
```

Reasoning defaults to `high` for deeper thinking on hard tasks. The remaining
defaults favor efficiency: low text verbosity, no visible reasoning summary, a
2,048-token hard completion limit per model request, a 12-turn tool limit, and
12 KiB per-tool output. Lower `reasoning` (for example `low` or `none`) for
simple tasks or tight token budgets; raise `maxOutputTokens`, `verbosity`,
`reasoningSummary`, `maxAgentTurns`, or `maxToolOutputBytes` for tasks that
need more capacity.

When a model consumes the entire output budget before producing answer text, CodeFarmer stops with
a clear error instead of silently changing the configured reasoning, verbosity, or output budget.
Increase `maxOutputTokens` or lower `reasoning` explicitly before retrying. Partial answers are kept
as-is.

DeepSeek streaming responses are parsed with the documented SSE keep-alive comments and `[DONE]`
terminator. A dropped socket or truncated stream is treated as a transient provider failure and the
same agent turn is replayed with exponential backoff (up to three attempts), so an incomplete stream
cannot be mistaken for a successful task. Tool-call turns also replay the complete
`reasoning_content` required by DeepSeek thinking mode.

For DeepSeek, `maxAgentTurns` is a soft checkpoint rather than an immediate stop: when a long task
reaches the configured number of tool rounds, CodeFarmer automatically extends the budget in chunks
and continues with the existing transcript, up to a hard safety cap of 100 rounds. Other providers
keep the configured limit strict.

Change the API endpoint globally, per project, or for one invocation:

```bash
codefarmer config set baseURL "https://gateway.example/v1"
codefarmer config set baseURL "https://gateway.example/v1" --project
codefarmer --base-url "http://localhost:8080/v1" run "Inspect this project"
```

`OPENAI_BASE_URL` is accepted as a fallback when `CODEFARMER_BASE_URL` is not
set. URLs are normalized without a trailing slash and must use HTTP(S) without
embedded credentials, query parameters, or fragments.

## Approvals and safety

| Policy      | Behavior                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| `ask`       | Reads run automatically; patches show a diff and commands ask first                      |
| `auto`      | Allowed workspace patches and ordinary commands run automatically; `git push` still asks |
| `read-only` | Mutations and non-read-only commands are rejected                                        |

Dangerous system commands, shell-wrapper bypasses such as `sh -c`, `cmd /c`,
and `powershell -Command`, and all Git writes except explicitly confirmed
`git push` commands are always denied. Sensitive
environment variables, including `OPENAI_API_KEY`, are removed from child
processes.

These are application-level controls. CodeFarmer v1 has no OS-level process,
filesystem, container, or network sandbox, and command side effects cannot be
undone. Prefer `ask`, keep work in version control, and use a disposable
container or VM for untrusted code. Read [docs/SECURITY.md](docs/SECURITY.md)
before enabling `auto`.

## Sessions, privacy, and logs

The OpenAI provider uses the Responses API with `store: true` by default and
resumes turns through `previous_response_id`. Prompts, selected code, tool
calls, and results sent to the model can therefore be retained by OpenAI under
your API account's data controls. Deleting a CodeFarmer session removes local
records only; it does not delete OpenAI-retained responses.

CodeFarmer v1 rejects `store: false`: stateless continuation would require
replaying complete reasoning and tool items, which this release intentionally
does not claim to support.

Sessions are pinned to the Base URL used when they are created. Start a new
session before changing endpoints; CodeFarmer refuses to resume a stored
`response_id` against a different service.

After the first turn, the model generates a short title from the conversation.
The first-message title remains as a fallback when generation fails, and
`sessions rename` always takes precedence.

Local sessions store messages, response IDs, tool/audit summaries, approvals,
patches, and hashes. Undo snapshots can contain prior source text. Pino writes
redacted daily JSONL logs and retains them for 14 days. Configuration, data,
and logs use standard per-user platform directories provided by `env-paths` and
are partitioned by a hash of the canonical workspace path.

## Errors and exit codes

User-facing errors are concise and actionable; `--verbose` adds stack traces.
Transient network, HTTP 429, and 5xx failures are retried up to two times.

| Code  | Meaning                                        |
| ----- | ---------------------------------------------- |
| `0`   | Success                                        |
| `1`   | Agent, API, or tool failure                    |
| `2`   | Invalid arguments or configuration             |
| `3`   | Approval rejected or unavailable without a TTY |
| `4`   | Authentication failure                         |
| `130` | Interrupted                                    |

## Development and release

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Tests use a programmable fake provider. A real OpenAI smoke test is optional
and requires `OPENAI_API_KEY`. GitHub Actions runs lint, type checking, tests,
build, package creation, and global-install smoke tests on Windows, macOS, and
Linux with Node.js 22 and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development rules and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for npm publishing, offline tarballs,
CI use, upgrades, uninstall, and local-data cleanup.

## License

[MIT](LICENSE)
