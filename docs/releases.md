# Releases

This repository packages a boardlab distribution. Its release version is the `version` field in `package.json`; it is
independent of the versions and tags of the `boardlab-core` and bsp submodules. Those projects are developed and tagged
in their own repositories, while the distribution records their exact revisions as gitlinks.

## Versions

- Stable versions use `0.<minor>.<patch>`.
- Release candidates use `0.<minor>.<patch>rc<N>`, such as `0.4.0rc1`.
- A release candidate is a validation build, not a stable GitHub release or a promise of a later stable release.

The distribution version and source revision are exposed together by `boardlab version`, `boardlab status`, and
`GET /api/version`. Build a release from the commit whose version and revision those interfaces should report.

## Building

From a clean checkout with submodules and dependencies installed:

```sh
pnpm install
pnpm run typecheck
pnpm check
pnpm run build
pnpm test
node scripts/release.mjs --source https://github.com/rzbdz/better-boardlab/releases/latest/download
```

`release.mjs` requires the version in `package.json`. `--out` selects the output directory and `--since` sets the changelog base explicitly. Unless `--no-build` is explicitly used, the script rebuilds the checkout, checks that the resulting CLI starts, and refuses uncommitted changes in release inputs.

The output directory contains:

- `boardlab-<version>.tar.gz`, containing the built CLI and frontends, public help and skills, license, installer, and
  the bsp files needed on board hosts;
- `install.sh`, the bootstrap installer with the selected release source;
- `release.json`, recording the distribution version, full source revision, tarball filename, SHA-256 digest, and the tagged core version and full revision;
- `CHANGELOG.md`, generated from commit subjects since the previous release or an explicit base.

The tarball also contains `VERSION`, `REVISION`, `CORE_VERSION`, and `CORE_REVISION`. Before archiving, the staged CLI must report the same distribution version and full revision.

The build outputs are release artifacts, not files to commit to the source repository.

## Architecture review

`scripts/release.mjs` builds through `pnpm run build`, which runs the architecture scan
(`core/scripts/check-architecture.mjs`), the generated-registry check, and the core version/tag check; a release cannot be
built while any of them fails. The scan is necessary but not sufficient: before cutting an RC or a stable release, run the
per-concept full-chain review described in [`docs/philosophy.md`](philosophy.md) — discovery, registration and ports,
boot/flash/SDK, locks/leases/slots, modules and the UI contract, release identity, consoles — from the backend contract
through the API, CLI, both frontends and tests. Record what it found in the release notes: what was fixed, and what
remains as a known boundary with an owner. A rule may not be loosened to let a release through.

## Publishing and provenance

`scripts/publish.mjs github <owner/repo>` creates a GitHub release named `v<version>` with the tarball, `release.json`,
and `install.sh`; the generated changelog becomes its release notes. Only stable versions can be published. Build and
validate RCs on a test installation without publishing them as stable releases.

## Retention

GitHub publishing keeps the newest three non-draft releases by creation time by default and deletes older releases
and their assets without deleting their source tags. `--keep <number>` changes that count for a publication run.

Service installation and updates retain the three newest directories under the installation's `releases/` directory,
selected by directory modification time. This local cache is independent of the GitHub release history; CLI-only setup
does not perform that service-installation pruning step.
