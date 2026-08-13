# Changelog

All notable changes to CodeFarmer are documented here. This project follows
[Semantic Versioning](https://semver.org/) and the structure recommended by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
