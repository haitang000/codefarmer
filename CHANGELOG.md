# Changelog

All notable changes to CodeFarmer are documented here. This project follows
[Semantic Versioning](https://semver.org/) and the structure recommended by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `list_skills` tool: the agent can rediscover the full skill catalog on
  demand instead of relying only on the compact catalog in the initial
  instructions. The output lists every skill's reference, description, and
  scope, including scoped references for duplicate names.

### Changed

- Sessions are now only persisted once they contain at least one message.
  Opening the TUI (or creating a session) and quitting without sending
  anything no longer leaves an empty session in `sessions list`.

## [0.1.5] - 2026-08-13

### Added

- `web_fetch` tool: the agent can now fetch HTTP(S) URLs and read their text
  content, bounded in size and time. Private, loopback, and link-local
  addresses are blocked by default, so repository content cannot turn the
  agent into a local-network scanner.
- `web_search` tool: the agent can search the web through DuckDuckGo (no API
  key required) and read result titles, URLs, and snippets, then follow up
  with `web_fetch` for full content. The endpoint inherits the `web_fetch`
  privacy and size boundaries.
- `apply_patch` now accepts a `files` array so several file patches can be
  applied in one call. The whole batch is validated before anything is
  written (a bad entry fails nothing has changed), approval covers the batch
  once and lists only the affected file names with change summaries, and a
  mid-batch failure rolls back the files already written.
- `todo_write` tool: the agent maintains a session todo list for multi-step
  tasks; the TUI shows it with `/todos`.
- `/review` TUI command: reviews the working-tree diff (staged and unstaged)
  through a read-only, ephemeral agent turn without committing.
- `/security-review [PATH...]` TUI command: a security-focused review of the
  working-tree diff (injection, secrets, authz, data handling, crypto,
  resource abuse), ordered by severity; optional paths scope the review.
- `codefarmer run` now reads the task description from standard input when no
  prompt argument is given, so `cat file | codefarmer run` and similar
  scripting work (`codefarmer run --json` included).
- Cost budgets: `budgetUsd` (config), `CODEFARMER_BUDGET_USD` (environment),
  and `--budget <usd>` (CLI) set a per-session cost ceiling estimated with the
  same public list prices as `stats`. Turns are refused with a
  `BUDGET_EXCEEDED` error once the session reaches the budget; the CLI
  one-shot path prints a warning when a run crosses it.
- `codefarmer setup` can add new custom endpoints and saves them into
  `customEndpoints`; re-running setup merges into the existing project config,
  preserving previously saved providers and other settings so multiple
  providers can coexist and be switched back to later.

### Changed

- TUI tool labels now switch tense with the tool lifecycle: progressive while
  running (e.g. `浏览中` / `Listing`), perfective after success (`已浏览` /
  `Listed`), and a failure form on errors (`浏览失败` / `List failed`).
- A bare `/model` now opens a keyboard model picker (↑/↓ + Enter) listing the
  models available for the active provider; `/model NAME` still switches
  directly.

## [0.1.4] - 2026-08-13

### Added

- `/sessions` now opens a keyboard-operated session picker in the TUI.
- The terminal title now reflects the agent's current activity while a task is
  running.

### Changed

- The reasoning effort of a conversation is now stored with the session and
  inherited: resuming a session restores the effort it ran at, and starting a
  new conversation (`/new`) carries the current effort over instead of
  reverting to the config default. The effort the model picks in `auto` mode
  is written back to the session record too, so it survives conversation
  switches and restarts instead of being re-decided from scratch.
- The TUI effort picker is now a keyboard-friendly slider.
- Tool labels in the TUI transcript are localized.

## [0.1.3] - 2026-08-13

### Fixed

- Align CLI and TUI version labels, plus generated configuration schema URLs,
  with the published package version.

## [0.1.2] - 2026-08-12

### Changed

- `/language` in the TUI now persists the choice to the user config file, so
  new sessions (`/new`, `/resume`) and later launches inherit the language
  instead of reverting to the previous default on the next runtime.
- The reasoning effort the model chooses in `auto` mode now carries over to
  subsequent requests in the same session (`inheritModelEffort`) instead of
  being re-decided every turn; explicit `/effort` settings are never overridden
  and `auto` is kept defensively when the model does not report a choice.

## [0.1.1] - 2026-08-12

### Added

- Initial TypeScript CLI and modular agent runtime.
- OpenAI Responses API provider with streamed output and resumable sessions.
- Configurable OpenAI-compatible Base URLs with endpoint-bound session recovery.
- `sessions export` renders a saved session as Markdown or JSON, printed to
  stdout or written to a file (`--format`, `--output`).
- Sessions receive a model-generated title after the first turn, based on the
  conversation; the first user message is retained as a fallback and
  `sessions rename <id> <title>` sets a custom title.
- Workspace-scoped file, search, patch, command, and read-only Git tools.
- Approval policies, mutation history, conflict-aware undo, structured logs,
  configuration management, diagnostics, and bilingual documentation.
- `git_log` shows commit history and `git_show` displays individual commits
  (patch or `--stat` summary), both read-only and kept inside the workspace
  boundary like the other Git tools.
- `completions <bash|zsh|fish>` prints generated shell completion scripts
  built from the live command tree, so they never drift from the CLI.
- `/commit` without a message asks the agent to summarize the working-tree
  diff (read-only, kept out of session history) and uses the summary as the
  commit message; an explicit message still commits directly.
- `stats` aggregates token usage and estimated cost across local sessions:
  human-readable by default, machine-readable JSON with `--json`. Models
  without a known public list price are listed separately and never counted
  as zero cost; all figures are estimates, not invoices.

### Fixed

- On macOS, application paths are resolved from the active `HOME` value at
  runtime, keeping spawned CLI processes and test environments aligned.
- Reaching `maxAgentTurns` no longer interrupts a run: the agent now sends a
  single `继续` instruction and keeps the full tool set, so long tasks
  continue invisibly until the model finishes naturally. Only if the model
  still loops on tool calls after twice the limit does the run fall back to
  a tool-less summary, so the user never sees a "reached the turn limit"
  interruption message for a task that is still making progress.
- TUI no longer cancels a running task when ESC is pressed: ESC only exits
  the transcript scroll view or clears the input draft, so an accidental ESC
  (for example closing an IME candidate window) cannot silently interrupt a
  long agent run. Cancel stays explicit via Ctrl+C or `/cancel`.
- Agent turns now recover from endpoints that reject stored-response
  continuation (for example "No tool call found for tool output") by
  replaying explicit conversation history instead of `previous_response_id`.
- Git tools report a clear optional-dependency error when Git is missing or
  the workspace is not a Git repository, and `doctor` treats Git as optional.
- `list_files` and `search_text` accept stringified `"null"` path arguments
  from gateways that do not preserve JSON nulls.
- The TUI input box no longer drops characters when typing quickly.
