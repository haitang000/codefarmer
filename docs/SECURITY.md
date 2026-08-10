# Security Model

CodeFarmer lets a model inspect a workspace, propose file changes, and run
local programs. That is inherently privileged. Read approval prompts and
review diffs, work from version control, and use a disposable environment for
untrusted repositories.

## Approval policies

| Policy          | Reads     | File changes           | Ordinary commands                    |
| --------------- | --------- | ---------------------- | ------------------------------------ |
| `ask` (default) | automatic | show diff and ask      | ask before execution                 |
| `auto`          | automatic | automatic in workspace | automatic if allowed; `git push` asks |
| `read-only`     | automatic | rejected               | rejected unless classified read-only |

Dangerous system commands, shell-wrapper bypasses, and Git write operations
other than `git push` remain blocked in every mode. `git push` always requires
an explicit interactive confirmation, even under `auto`. In a non-interactive
process, an operation that requires confirmation fails with exit code `3`;
CodeFarmer never silently approves it.

Approval is an application policy, not isolation. In particular, `auto` allows
an approved executable to perform anything permitted by the current operating
system account. A seemingly ordinary package or build command can execute
repository scripts or downloaded code.

## Workspace and file protections

- The workspace root is exactly `--cwd` or the process startup directory. It
  is not widened to the containing Git repository.
- Existing targets are checked through their canonical real path. New targets
  are checked through the canonical parent. Absolute paths, `..` traversal,
  and symlink escapes are rejected.
- `.git`, dependency and build output directories, `.env` files, private keys,
  and certificates are ignored by default. `.env.example` may be read.
- The default file limit is 1 MiB and tool output is truncated at 100 KiB.
  Binary or invalid UTF-8 content is not patched.
- Patches require the expected SHA-256 hash, use atomic replacement, and fail
  on concurrent changes. Undo also checks the post-change hash before restore.

These checks constrain CodeFarmer's built-in file tools. They cannot constrain
a child process that receives an allowed command.

## Command protections

`run_command` accepts an executable and argument array, an in-workspace
working directory, and a timeout (120 seconds by default). It does not pass a
model-supplied string to a shell. Shell wrappers such as `sh -c`, `cmd /c`, and
`powershell -Command`, destructive system commands, and Git write commands
including commit, checkout/switch, reset, clean, merge, rebase, and tag are
rejected. `git push` is permitted only after the user explicitly confirms the
complete command; this confirmation cannot be bypassed by the `auto` policy.

Before a process starts, CodeFarmer removes `OPENAI_API_KEY` and environment
variables whose names indicate tokens, secrets, passwords, or private keys.
This reduces accidental disclosure; it does not prevent a process from reading
other files, using inherited user credentials, accessing the network, or
starting additional processes.

## No OS-level sandbox

CodeFarmer v1 does **not** provide containers, seccomp, Windows restricted
tokens, filesystem virtualization, or network isolation. Approval dialogs,
argument validation, environment filtering, and workspace checks are defense
in depth, not a sandbox.

For higher-risk work, run CodeFarmer inside a container or disposable virtual
machine with a minimal filesystem mount, no ambient cloud credentials, a
non-administrator account, and restricted network access. Do not use `auto` on
code you do not trust.

## OpenAI data and privacy

The OpenAI Responses provider defaults to `store: true` and uses
`previous_response_id` to resume server-side response state. Prompts, selected
workspace content, tool calls, and tool results sent to the model therefore
leave the local machine and may be retained by OpenAI according to the API
account's data controls and applicable OpenAI terms. Review those controls
before processing confidential or regulated source code.

Deleting a local CodeFarmer session removes only the local session index and
audit data. It does not delete a response retained by OpenAI. CodeFarmer v1
rejects `store: false` because continuation depends on server-side response
state; this restriction is not a deletion mechanism for retained responses.

A custom `baseURL` receives the same API key, prompts, selected source code,
tool schemas, and tool results that would otherwise be sent to OpenAI. Configure
only an endpoint you trust and control. CodeFarmer rejects URLs with embedded
credentials, query strings, or fragments, but it cannot verify the operator or
data-handling policy of a custom service.

Response IDs are scoped to their endpoint. Each saved session records its Base
URL, and CodeFarmer rejects an explicit endpoint change while resuming that
session.

## Local data and logs

Sessions contain user messages, final answers, response IDs, tool arguments,
approval decisions, patch/hash audit data, and bounded tool results. Mutation
snapshots can contain previous source text. Daily JSONL logs are retained for
14 days and redact authorization headers, API keys, sensitive environment
variables, and file bodies. Redaction is best effort; protect the platform
data and log directories with normal user permissions.

`OPENAI_API_KEY` is resolved from the environment first, then from a local
credential file (`credentials.json`, written with mode 0600) that
`codefarmer setup` stores in the per-user configuration directory outside any
workspace. The credential file never enters a project repository. Do not place
the key in `codefarmer.config.json`, command history, issue reports, or
committed `.env` files. The `config set` command rejects attempts to persist
it.

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, or private
source. Contact the maintainers through the repository's private security
reporting channel and include affected versions, impact, reproduction steps,
and suggested mitigations. Rotate any credential that may have been exposed.
