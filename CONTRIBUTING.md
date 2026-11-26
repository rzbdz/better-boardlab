# Contributing

Thank you for contributing to better-boardlab. Keep changes focused, preserve the module boundaries, and include tests
for the behavior you change.

## Development setup

Use Node.js 24 or newer and the pnpm version declared in `package.json` (for example, through Corepack).

```sh
git clone --recurse-submodules https://github.com/rzbdz/better-boardlab.git
cd better-boardlab
pnpm install
pnpm run build
```

Run the CLI from this checkout with `node dist/cli.js`, or start boardd with `node dist/cli.js serve`.

This repository combines [boardlab-core](https://github.com/rzbdz/boardlab-core) with distribution modules.
`core/` and `externals/boardctrl` are git submodules:

- Make core changes in the boardlab-core repository and bsp changes in the bsp repository.
- Test and commit those changes in their owning repositories.
- Update the corresponding submodule checkout and commit only the resulting gitlink update in this distribution.
- Do not copy submodule source changes into a distribution commit as ordinary files.

## Modules and frontends

Distribution modules live in `src/modules/<id>/`. A module may provide a boardd entry, CLI commands, and views described
by `src/ui/contract.ts`. Frontends render these views and must not depend on module internals.

After adding or removing a module, run `pnpm modules` to regenerate `src/catalog.ts`, `src/commands.ts`, and `src/uis.ts`.
Commit the generated registries with the module change. Follow `architecture.json`; its checks enforce the permitted
imports and layering.

## Validation

Run checks appropriate to the change, including focused tests while iterating. Before submitting a complete change, run:

```sh
pnpm run typecheck
pnpm check
pnpm run build
pnpm test
```

Use fake boardd data and fake hardware in tests. Never make an automated test reset, flash, scan, or otherwise operate
a real lab board. Hardware operations require an explicit user request and the shared board lock; discovery and scans
can reset every board they touch.

Do not commit `node_modules/`, `dist/`, release output, local state databases, CLI tokens, credentials, logs, or other
machine-local configuration. Keep public documentation free of private hosts and site-specific configuration.

## Commits and review

Organize each commit as one complete, validated change, with a concise subject and a body explaining its purpose.
Include relevant generated files and tests, and review the staged diff before committing. Do not mix unrelated cleanup
into a functional change.

Commits must be signed and carry the repository owner's `Signed-off-by` trailer. Use the configured Git identity and
signing key, for example:

```sh
git commit -S -s -m "type: concise subject" -m "Describe the final change and its purpose."
git verify-commit HEAD
```

Do not add AI attribution trailers. Report the validation performed and any hardware behavior that remains untested.
