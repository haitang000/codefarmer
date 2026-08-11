# AGENT.md

Project-specific guidance for coding agents working in this repository.

## Project Overview

CodeFarmer is a safe, interactive coding-agent CLI (v0.1.0, MIT) powered by a
multi-provider model boundary (OpenAI, Google Gemini, xAI Grok, DeepSeek, and
Kimi). OpenAI defaults to the Responses API with `gpt-5.6-sol`; the other
providers go through an OpenAI-compatible endpoint. It inspects a workspace,
edits files through reviewable unified diffs (`apply_patch`), runs approved
commands, exposes read-only Git tools, and can resume prior sessions. It ships
a full-screen Ink TUI and a one-shot `run --json` mode, plus a `push` command
that pushes the current branch to its remote and always requires explicit
confirmation (even under `--approval auto`; see Important Constraints). The
project is also self-hosting: the TUI `/init` command inspects a workspace and
creates/updates this `AGENT.md`.

Stack: TypeScript (strict), ESM (`"type": "module"`), Node.js >= 22, pnpm
(10.28.0), React 19 + Ink (TUI), Commander, Clack, Chalk, Zod, Pino, execa,
`openai` SDK, Vitest, tsup, tsx, ESLint + typescript-eslint, Prettier.

## Repository Layout

```text
src/
├─ cli/        Commander entrypoint, script commands, completions, export
├─ tui/        Ink full-screen app, transcript, input, overlays
├─ core/       Agent loop, prompts, approvals, sessions, undo transactions
├─ providers/  AgentProvider contract boundary, provider catalog, OpenAI +
│              OpenAI-compatible implementations
├─ tools/      list_files/read_file/search_text, apply_patch, write-file,
│              run-command, read-only git tools, registry, output
└─ infra/      config, credentials, paths, persistence, logger, typed errors
tests/         Vitest suites mirroring src (tests/tools/* for tool tests)
docs/          ARCHITECTURE.md, SECURITY.md, DEPLOYMENT.md
schemas/       JSON Schema for codefarmer.config.json
```

Main public contracts: `AgentProvider`, `ProviderEvent`, `ProviderId`,
`ToolDefinition`, `ToolResult`, `ToolLifecycleHooks`, `ApprovalPolicy`,
`SessionRecord`, `MutationTransaction`, `CodeFarmerConfig` (exported from
`src/index.ts`).

## Development Commands

All commands run with pnpm; Node.js >= 22 required.

```bash
pnpm install          # install dependencies (corepack enable first if needed)
pnpm dev              # run the CLI from source (tsx src/cli.ts)
pnpm lint             # eslint . (strict type-checked rules)
pnpm lint:fix         # eslint . --fix
pnpm format           # prettier --write .
pnpm format:check     # prettier --check .
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run (node environment, 15s test timeout)
pnpm test:watch       # vitest watch
pnpm build            # tsup -> dist/cli.js (bin) + dist/index.js (+ .d.ts)
pnpm check            # lint + typecheck + test + build (also runs on prepack)
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, build, `pnpm pack`,
and a global-install smoke test on ubuntu/macos/windows with Node 22 and 24
using `pnpm install --frozen-lockfile`.

## Coding Conventions

- TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`; `module`/`moduleResolution`
  are `NodeNext`, so relative imports use explicit `.js` extensions
  (e.g. `import { X } from '../infra/errors.js'`).
- Prettier: single quotes, trailing commas (all), semicolons, print width 100.
- ESLint uses `strictTypeChecked` + `stylisticTypeChecked`; type-only imports must
  use `import type` (`@typescript-eslint/consistent-type-imports` is an error).
- Vitest globals are enabled via tsconfig `types`; tests use a `ScriptedProvider`
  fake and must not require network access or a real API key.
- Keep changes focused, cross-platform (Windows/macOS/Linux), and covered by tests
  proportional to risk; public behavior changes must update both `README.md` and
  `README.zh-CN.md`.

## Testing

- `pnpm test` runs the full Vitest suite in a node environment; `tests/tools/*`
  covers the tool layer. `pnpm check` is the full gate before a PR.
- A live provider smoke test is optional and requires an API key in the
  environment (unit/integration/CLI tests must never need one).

## Important Constraints

- Preserve the `AgentProvider` boundary: provider SDK types must not leak into
  `core/` or `tools/`. Provider support is defined by `PROVIDER_PRESETS` in
  `src/providers/catalog.ts`; adding a provider means updating that catalog and
  the supported env-var/API-key lists.
- Provider credentials come from the environment only
  (`OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
  `XAI_API_KEY`/`GROK_API_KEY`, `DEEPSEEK_API_KEY`,
  `MOONSHOT_API_KEY`/`KIMI_API_KEY`). Never add a configuration path that
  persists an API key; credentials and sensitive env vars are stripped from
  child processes.
- Tool parameters are untrusted input: keep path containment, symlink, size,
  approval, and command-risk checks intact. `run_command` takes an executable
  and an argument array — never a shell string; shell-wrapper bypasses
  (`sh -c`, `cmd /c`, `powershell -Command`), dangerous system commands, and
  all Git writes except `git push` are always denied. `git push` must always
  receive explicit user confirmation, including with the `auto` policy.
- Git operations in this repo's tooling are read-only (`git_status`, `git_diff`,
  `git_log`, `git_show`), except for explicitly confirmed `git push` commands
  through `run_command`; do not add other Git writes or shell-string execution
  without separate security design and review.
- Config precedence: CLI flags > `CODEFARMER_*` env vars > workspace
  `codefarmer.config.json` > user config > built-in defaults. Do not commit
  `.env*`, `dist/`, `coverage/`, logs, session data, or undo snapshots
  (`.gitignore` covers these; `.env.example` stays readable).
- Exit codes: 0 success, 1 agent/API/tool failure, 2 invalid args/config,
  3 approval rejected or no TTY, 4 authentication failure, 130 interrupted.
- `app-hex.txt` at the repo root is a hex-dump artifact (not source); leave it
  alone. `codefarmer.config.json` at the root is local project config.
- See `docs/SECURITY.md` before enabling `--approval auto`: CodeFarmer's
  approval and path checks are not an OS-level sandbox.
