# Changelog

All notable changes to CodeFarmer are documented here. This project follows
[Semantic Versioning](https://semver.org/) and the structure recommended by
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial TypeScript CLI and modular agent runtime.
- OpenAI Responses API provider with streamed output and resumable sessions.
- Configurable OpenAI-compatible Base URLs with endpoint-bound session recovery.
- `sessions export` renders a saved session as Markdown or JSON, printed to
  stdout or written to a file (`--format`, `--output`).
- Sessions derive an automatic title from the first user message, shown in
  `sessions list` and exports; `sessions rename <id> <title>` sets a custom
  title.
- Workspace-scoped file, search, patch, command, and read-only Git tools.
- Approval policies, mutation history, conflict-aware undo, structured logs,
  configuration management, diagnostics, and bilingual documentation.
- `git_log` shows commit history and `git_show` displays individual commits
  (patch or `--stat` summary), both read-only and kept inside the workspace
  boundary like the other Git tools.
- `completions <bash|zsh|fish>` prints generated shell completion scripts
  built from the live command tree, so they never drift from the CLI.

### Fixed

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
