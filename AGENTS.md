# Repository Guidelines

## What this is

boardlab is the development board lab: the boardd service, the `boards` CLI and its web page, and the Claude skill that teaches the CLI.

- `src/server`: boardd. It reaches local hardware only through Home Assistant, serial-mux and fastboot, and boards in a remote lab only through that lab's own web API and its jump host.
- `src/cli`: the `boards` CLI; `boards serve` runs boardd.
- `src/shared`: the client library and the types the CLI, the web page and other programs share.
- `src/ui`: the web page boardd serves.
- `firmware/`: the firmware boardd loads, registered in `firmware.json` with each file's sha256.
- `skills/boards`: the Claude skill for the `boards` CLI.

boardlab is standalone. It must not depend on any agent framework, chat host or backend that uses it; those reach boards only through the `boards` CLI, the skill, or the client library.

## Public Code and Internal Materials

- `internal/` holds local, private materials such as plans, development notes, acceptance reports, screenshots and raw serial logs.
- **Never commit, publish, or include any part of `internal/` in release artifacts.** Keep the `/internal/` rule in `.gitignore`. Do not bypass it with `git add -f` or any other mechanism.
- Preserve internal materials locally; do not delete them when organizing the repository. Their absence in a fresh clone must not prevent building or running the project.
- `README.md` and the files under `skills/` are public. Do not copy internal plans or acceptance records into them, and keep out personal information, private addresses, credentials, Home Assistant tokens and local logs.
- Do not commit state databases, CLI tokens, dependencies or build output. Before committing, inspect `git diff --cached --name-only` and the staged content.

## Branches and Merging

- Develop every change on a dedicated branch, never directly on `main`.
- Before merging into `main`, rewrite the branch into clean commits organized by functional module, each complete and working on its own. Fold fixes for code introduced on the same branch into the commit they belong to.
- A `fix:` commit on `main` is only for a defect in code already on `main`.

## Commits

- Use a concise subject and a short body describing the final change and its purpose. Do not include a development diary.
- End every commit message with the repository owner's own `Signed-off-by` trailer only. Never add AI attribution trailers such as `Co-Authored-By`.
- When amending, review the complete resulting diff and rewrite the message if the scope changed.
- Every commit must carry an OpenPGP signature made with the configured signing key, including amended or rewritten commits. Verify with `git verify-commit`. If signing fails, report it instead of committing unsigned.
- Keep this file in English.

## Hardware Safety

- People and Claude share one set of board locks. Take the lock before resetting, entering fastboot, booting or typing on a console, and release it afterwards. Tests must use fake hardware, never the real lab.
- A scan resets every slot it touches; run one on the real lab only when the owner asks for it.

## Validation

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

boardd runs from this checkout's `dist/`, so a build changes what the next boardd start runs. Restart the service only when no board is locked.
