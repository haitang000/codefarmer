# Installation, Deployment, and Release

## Prerequisites

- Node.js 22 or newer (Node.js 22 and 24 are tested)
- pnpm through Corepack for source builds
- An OpenAI API key for live agent calls
- Git (optional) for the read-only `git_status`, `git_diff`, `git_log`, and
  `git_show` tools

Set the API key in the environment rather than configuration:

```bash
export OPENAI_API_KEY="sk-..."
```

```powershell
$env:OPENAI_API_KEY = "sk-..."
```

To use a trusted OpenAI-compatible gateway, configure its API root including
the version path:

```bash
codefarmer config set baseURL "https://gateway.example/v1"
```

For project-specific or ephemeral settings, use `--project` or
`--base-url <url>`. `CODEFARMER_BASE_URL` takes precedence over the
SDK-compatible `OPENAI_BASE_URL` fallback. Custom endpoints receive the
configured API key and workspace content sent to the model; review their
security and retention policy.

## Install from npm

```bash
npm install -g codefarmer
codefarmer --version
codefarmer doctor
```

For a source checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm install -g .
codefarmer --help
```

`OPENAI_API_KEY` is not needed for builds or the fake-provider test suites.
Live OpenAI verification is opt-in and must be run manually with a valid key.

## Offline tarball installation

On a connected build machine, install dependencies, test, and create the npm
tarball:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm pack
```

Transfer the resulting `codefarmer-<version>.tgz` through the approved channel,
then install it on the target machine:

```bash
npm install -g ./codefarmer-<version>.tgz
codefarmer doctor
```

The CLI package can be installed offline, but agent calls still require access
to the OpenAI API. Use checksums or a trusted artifact registry when moving
tarballs between environments.

## CI and non-interactive use

Use `run --json` so stdout contains one stable machine-readable result; send
diagnostics and logs to stderr. `ask` cannot display an approval prompt without
a TTY, so a pending mutation or command exits with code `3`.

For analysis-only jobs, use the read-only policy:

```bash
codefarmer --approval read-only run --json "Review this workspace for errors"
```

Use `--approval auto` only in an isolated, disposable runner whose repository,
credentials, permissions, and network have been intentionally constrained.
CodeFarmer does not provide an OS-level sandbox. Parse both the JSON `status`
and process exit code; authentication failures use `4`, configuration errors
use `2`, and interruptions use `130`.

The repository workflow tests Windows, macOS, and Linux on Node.js 22 and 24.
It runs linting, type checking, tests, build, package creation, and a global
tarball smoke test without real OpenAI credentials.

## Publishing to npm

Before publishing:

1. Confirm that the `codefarmer` package name remains available and that the
   npm account has publish permission and 2FA configured.
2. Update the version and `CHANGELOG.md`, then verify a clean Git worktree.
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. Run `pnpm pack`, inspect the tarball contents, install it globally, and
   smoke-test `codefarmer --help`, `--version`, and `doctor`.
5. Publish with the intended npm tag and provenance settings:

```bash
npm publish --access public
```

Never place `OPENAI_API_KEY` or an npm token in the package, repository, test
fixtures, build logs, or persisted CodeFarmer configuration.

## Upgrade and rollback

```bash
npm install -g codefarmer@latest
```

To roll back, install a known version or retained tarball:

```bash
npm install -g codefarmer@<version>
```

User configuration and session schemas should remain backward compatible
within a major version. Back up the platform data directory before testing a
new major version if session or transaction history matters.

## Uninstall and data cleanup

Remove the executable and package first:

```bash
npm uninstall -g codefarmer
```

This intentionally leaves user configuration, sessions, undo snapshots, and
logs. Before uninstalling, `codefarmer config path` prints the active user
configuration path. CodeFarmer uses `env-paths('codefarmer', { suffix: '' })`;
remove the corresponding `codefarmer` config, data, cache, and log directories
manually if complete local cleanup is required. Common roots are:

| Platform | Configuration                      | Data and logs                                                              |
| -------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Windows  | `%APPDATA%\codefarmer`             | `%LOCALAPPDATA%\codefarmer`                                                |
| macOS    | `~/Library/Preferences/codefarmer` | `~/Library/Application Support/codefarmer` and `~/Library/Logs/codefarmer` |
| Linux    | `~/.config/codefarmer`             | `~/.local/share/codefarmer` and `~/.local/state/codefarmer`                |

Inspect the resolved directories before deleting them. Removing transaction
data permanently disables CodeFarmer undo for those changes. Local cleanup
does not delete Responses API data retained by OpenAI; refer to the OpenAI
account's data controls and retention process.
