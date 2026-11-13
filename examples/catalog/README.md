# Example catalog (a site repository to copy)

A minimal **catalog** — the site repository boardd keeps for its bsp board hosts — showing the
part that matters when a lab has both public hardware and private details: a site is an
**overlay**, not a fork.

```text
catalog/
  bsp.yaml                     which public packs to build on (here: spacemit)
  socs/k3/soc.yaml             OVERLAY on bsp's public k3 profile: a private helper image + the steps that use it
  sdk/servers/build-a.yaml     a build server
  sdk/families/make-bsp.yaml   a build style (top-level Makefile)
  sdk/instances/vendor-bsp.yaml  an SDK: source tree, artifacts, boot recipes
  .gitignore                   keeps the fetched images out of git
```

## Three layers, three owners

| layer | holds | who ships it |
|---|---|---|
| bsp core | mechanism: locks, jobs, consoles, steps, hooks | bsp repository |
| bsp packs (`packs/<name>/`) | public hardware facts: boot-ROM fingerprints, download-mode patterns, USB ids, pin maps, public hooks | bsp repository — **ships with boardlab** (`externals/bsp`) when `bsp.yaml` selects the pack |
| site (this repository) | everything only your lab has: build servers, SDK trees and recipes, private images and helpers, hosts, hints | you |

So the SpacemiT K3 SoC profile is public and already ships: `packs/spacemit/socs/k3/soc.yaml`
in bsp. A site does **not** copy it. `socs/k3/soc.yaml` here only adds what the pack cannot
know — in this example a boot-ROM helper image that is fetched from its own source and the
`media_boot` steps that stage it. Everything else (fingerprint, download mode, identify
fields, probe image names) still comes from the pack, and a later bsp update to the pack
reaches you without a merge conflict.

The merge is deep, per key, site last: write only the keys you add or change. Image files can
be put in the site (`socs/k3/helper.bin`), fetched from a URL, a git repository at a pinned
ref, or a file on boardd's machine; `bsp images sync` fetches them into `.blobs/<sha256>/`
and nothing is kept unless it hashes right. `boardd` runs that before syncing the site to the
board hosts, so hosts never fetch anything themselves.

> `source: {url: …}` in `socs/k3/soc.yaml` points at `example.org` on purpose. Replace the
> URL, the `sha256`, and the file name with the helper you actually use.

## Use it

```sh
git clone <your copy of this directory> my-lab-catalog     # or copy it
cd my-lab-catalog && $EDITOR bsp.yaml socs/… sdk/…

# try the files with bsp directly (no boardd needed)
BSP_SITE=$PWD bsp images list        # what the catalog adds, where each image comes from
BSP_SITE=$PWD bsp images sync        # fetch the images into .blobs/ (checked by sha256)

# then, in boardlab: 设置 → 站点 → 换来源 → this repository
# or: boardlab site pull / boardlab site sync
```

The boardd page checks the site with bsp's own readers before saving, so a site that syncs is
a site the hosts can read.

## What belongs in a public example, and what never does

This directory is public: no real host names or addresses, no credentials or tokens, no
vendor-private image URLs, no paths that exist only in one lab. Addresses use the
documentation range `192.0.2.0/24`. A real catalog is usually a private git repository; keep
it that way, and contribute the *public* parts (SoC facts, pin maps) back to a bsp pack.

Every file format is shown in full in bsp's `examples/site/`; the help pages in boardlab
describe them in Chinese (`站点`, `SoC 资料`, `编译服务器`, `SDK 的源码树和构建方式`).
