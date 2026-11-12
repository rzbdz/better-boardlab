#!/bin/sh
# Install or update boardlab on this machine. This script only fetches a release and runs that release's own
# installer (setup.sh in its tarball), so what installing does comes with each release:
#
#   curl -fsSL <release>/install.sh | sh                                  # the release this script came with
#   curl -fsSL <release>/install.sh | sh -s -- --from <source> [options]  # another release, or another place
#   sh install.sh --uninstall [--purge]
#
# A source is one of:
#   https://host/path                      a directory with release.json and the tarball it names (a GitHub
#                                          release's .../releases/latest/download)
#   <path or URL>.tar.gz                   a release tarball (installed as it is; updates need one of the others)
#   git@host:group/repo.git#branch         a git repository with the release on a branch (`release` by default),
#   ssh://host/repo.git#branch             cloned with this machine's own ssh key or git credentials
#   https://host/group/repo.git#branch
#   https://host/api/v4/projects/<id>#branch  a git server's project API; a private project takes --token (or
#                                          BOARDLAB_TOKEN), sent only there and kept for updates
#
# Every option goes on to setup.sh (--port, --host, --origin, --cli, --node, --token, --force, ...), followed by
# --source <source> and --unpacked <the release's directory>.
#
# FROZEN INTERFACE. Installed machines keep this script as <prefix>/install.sh and run `install.sh --from <source>`
# for every update, from any release to any later one. Keep its options, the source forms, what it reads from
# release.json (file, sha256) and how it calls setup.sh as they are. New behaviour goes in setup.sh.
set -eu
BASE=${BOARDLAB_RELEASE:-@RELEASE_SOURCE@}
case $BASE in @*) BASE="" ;; esac
FROM="" TOKEN=${BOARDLAB_TOKEN:-} CLI="" UNINSTALL="" prev=""
for arg in "$@"; do
  case $prev in --from) FROM=$arg ;; --token) TOKEN=$arg ;; esac
  case $arg in --cli) CLI=1 ;; --uninstall) UNINSTALL=1 ;; esac
  prev=$arg
done
die() { printf '!! %s\n' "$*" >&2; exit 1; }
if [ "$(id -u)" = 0 ] && [ -z "$CLI" ]; then PREFIX=/opt/boardlab; else PREFIX=$HOME/.local/share/boardlab; fi

# Uninstalling is the installed release's to do.
if [ -n "$UNINSTALL" ]; then
  for file in setup.sh install.sh; do [ -f "$PREFIX/current/$file" ] && exec sh "$PREFIX/current/$file" "$@"; done
  die "boardlab is not installed in $PREFIX"
fi
# The token a private source takes, kept from the first install.
[ -z "$TOKEN" ] && [ -r "$PREFIX/release-token" ] && TOKEN=$(cat "$PREFIX/release-token")

SRC=${FROM:-$BASE}; SRC=${SRC%/}
[ -n "$SRC" ] || die "say where the release is: --from <source>"
REPO=${SRC%%#*} REF=release
case $SRC in *\#*) REF=${SRC#*#} ;; esac
case $SRC in
  *.tar.gz|*.tgz) KIND=tarball ;;
  */api/v4/projects/*) KIND=api ;;
  *.git|*.git\#*|git@*|ssh://*|git+*) KIND=git ;;
  *) KIND=dir ;;
esac
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# get <URL or path> <file> [header]
get() {
  case $1 in
    http://*|https://*)
      if command -v curl >/dev/null; then curl -fsSL --connect-timeout 15 ${3:+-H "$3"} "$1" -o "$2"
      else wget -q -T 15 ${3:+--header="$3"} -O "$2" "$1"; fi ;;
    *) cp "$1" "$2" ;;
  esac
}
# A file of the release: from its directory, its git branch, or the project API (with the token).
fetch() {
  case $KIND in
    api) HOW="without a token (a private project needs --token)"; [ -n "$TOKEN" ] && HOW="with the token given"
         get "$REPO/repository/files/$1/raw?ref=$REF" "$2" ${TOKEN:+"PRIVATE-TOKEN: $TOKEN"} || die "could not fetch $1 from $REPO, branch $REF, $HOW" ;;
    git) cp "$TMP/git/$1" "$2" 2>/dev/null || die "$1 is not on branch $REF of $REPO" ;;
    *) get "$SRC/$1" "$2" || die "could not fetch $SRC/$1" ;;
  esac
}

if [ "$KIND" = git ]; then
  command -v git >/dev/null || die "git is needed to fetch $REPO"
  # A machine meeting the git server for the first time takes its host key instead of stopping to ask, unless told
  # how to run ssh.
  if [ -z "${GIT_SSH_COMMAND:-}${GIT_SSH:-}" ] && ! git config core.sshCommand >/dev/null 2>&1; then
    GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"; export GIT_SSH_COMMAND
  fi
  git clone -q --depth 1 -b "$REF" -- "${REPO#git+}" "$TMP/git" || die "could not fetch branch $REF of $REPO"
fi
if [ "$KIND" = tarball ]; then
  get "$SRC" "$TMP/boardlab.tar.gz" || die "could not fetch $SRC"
else
  fetch release.json "$TMP/release.json"
  field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$TMP/release.json" | head -n 1; }
  FILE=$(field file) SUM=$(field sha256)
  case $FILE in ''|.*|*[!A-Za-z0-9._-]*) die "release.json from $SRC names no tarball (file)" ;; esac
  [ -n "$SUM" ] || die "release.json from $SRC has no sha256"
  fetch "$FILE" "$TMP/boardlab.tar.gz"
  [ "$(sha256sum "$TMP/boardlab.tar.gz" | cut -d' ' -f1)" = "$SUM" ] || die "the tarball's sha256 does not match release.json"
fi
mkdir "$TMP/x"; tar -xzf "$TMP/boardlab.tar.gz" -C "$TMP/x" || die "could not unpack the release from $SRC"
DIR=$(ls -d "$TMP"/x/boardlab-* 2>/dev/null | head -n 1)
[ -n "$DIR" ] && [ -f "$DIR/VERSION" ] || die "not a boardlab release: $SRC"

# The release's own installer. A release from before setup.sh existed has it all in its install.sh, which fetches
# the release again itself.
if [ -f "$DIR/setup.sh" ]; then sh "$DIR/setup.sh" "$@" --source "$SRC" --unpacked "$DIR"
else sh "$DIR/install.sh" "$@" --from "$SRC"
fi
