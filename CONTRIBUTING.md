# Contributing to CodeFarmer

CodeFarmer requires Node.js 22 or newer and pnpm. Keep changes focused,
cross-platform, and covered by tests appropriate to their risk.

## Local setup

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Set `OPENAI_API_KEY` only when manually exercising the live provider. Unit,
integration, and CLI tests use fakes and must not require network access or a
real key.

To exercise the locally built executable:

```bash
node dist/cli.js --help
npm install -g .
codefarmer doctor
```

## Change requirements

- Preserve the `AgentProvider` boundary; provider SDK types must not leak into
  the core or tools.
- Treat tool parameters as untrusted input. Keep path containment, symlink,
  size, approval, and command-risk checks intact.
- Never add a configuration path that persists `OPENAI_API_KEY`.
- Do not add Git write operations or shell-string execution without a separate
  security design and review.
- Add or update English and Chinese user documentation when public behavior
  changes.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before
  opening a pull request.

## Commit and pull request guidance

Use concise, imperative commit subjects. A pull request should explain the
observable change, security implications, tests run, and any compatibility or
deployment impact. Do not commit generated `dist/`, coverage output, local
configuration, logs, session data, undo snapshots, or credentials.

## Releasing

Maintainers follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). A release requires
a clean test matrix, a locally installed tarball smoke test, an updated
changelog, and a final npm name and account-permission check.
