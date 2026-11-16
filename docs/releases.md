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

`release.mjs` defaults to the version in `package.json` and the `release/` output directory. `--version` and `--out`
override those values; `--since` sets the changelog base explicitly. Unless `--no-build` is explicitly used, the script
rebuilds the checkout, checks that the resulting CLI starts, and refuses uncommitted changes in release inputs.

The output directory contains:

- `boardlab-<version>.tar.gz`, containing the built CLI and frontends, public help and skills, license, installer, and
  the bsp files needed on board hosts;
- `install.sh`, the bootstrap installer with the selected release source;
- `release.json`, recording the distribution version, source revision, tarball filename, and SHA-256 digest;
- `CHANGELOG.md`, generated from commit subjects since the previous release or an explicit base.

The build outputs are release artifacts, not files to commit to the source repository.

## Publishing and provenance

`scripts/publish.mjs git <repository>` publishes the generated files on a replaceable release branch, including the
changelog, and creates a `v<version>` tag where tagging succeeds.

`scripts/publish.mjs github <owner/repo>` creates a GitHub release named `v<version>` with the tarball, `release.json`,
and `install.sh`; the generated changelog becomes its release notes. GitHub publishing currently marks the release as
latest and does not set the prerelease flag from the version string. Do not treat an RC version string alone as proof
that publication was RC-safe.

The intended stable-release contract is that a validated release's version, source revision, artifacts, checksum, and
provenance remain consistent and its stable tag is not moved. The current publish tooling does not enforce immutable
tags or prevent republishing, so review the target and generated metadata before every publication. RCs should be built
and validated on a test installation without being presented as stable releases.

## Retention

GitHub publishing keeps the newest three non-draft releases by creation time by default and deletes older releases,
their assets, and their tags. `--keep <number>` changes that count for a publication run. This automatic pruning can
remove an older tag even though release provenance should otherwise be treated as stable.

A git release branch is force-replaced by each publication; its old branch commits are not a retention mechanism.
Service installation and updates retain the three newest directories under the installation's `releases/` directory,
selected by directory modification time. This local cache is independent of the GitHub release history; CLI-only setup
does not perform that service-installation pruning step.
