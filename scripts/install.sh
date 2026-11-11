#!/bin/sh
# Install or update boardlab on this machine, in one step:
#
#   curl -fsSL <release>/install.sh | sh                       # the release this script came with
#   curl -fsSL <release>/install.sh | sh -s -- --from <source>   # another release
#   sh install.sh --uninstall [--purge]
#
# A source is a release directory (URL or path, holding release.json and the tarball), a tarball, or a git repository
# with the release on a branch (`git@host:group/repo.git#release`, for a server only reachable over ssh).
#
# As root it sets boardlab up as a service: the program in /opt/boardlab (releases/<version>, `current` links the one in
# use), state in /var/lib/boardlab, the `boardd` systemd unit, and `boardlab` on PATH. As another user it installs only
# the CLI under ~/.local. Updating swaps `current` and restarts boardd once no board is locked; the state, boardd.json
# and the page's settings are kept. Node >= 24 comes from PATH, /opt/node, or is fetched.
set -eu
BASE=${BOARDLAB_RELEASE:-@RELEASE_SOURCE@}
case $BASE in @*) BASE="" ;; esac
FROM="" UNINSTALL="" PURGE="" PORT=38127 HOSTS="" ORIGIN="" FORCE=""
while [ $# -gt 0 ]; do
  case $1 in
    --from) FROM=$2; shift 2 ;; --port) PORT=$2; shift 2 ;; --host) HOSTS="$HOSTS --host $2"; shift 2 ;; --origin) ORIGIN="$ORIGIN --origin $2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;; --purge) PURGE=1; shift ;; --force) FORCE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say() { printf '==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" = 0 ]; then PREFIX=/opt/boardlab STATE=/var/lib/boardlab BIN=/usr/local/bin SERVICE=1; else PREFIX=$HOME/.local/share/boardlab STATE=$HOME/.local/state/boardlab BIN=$HOME/.local/bin SERVICE=""; fi

if [ -n "$UNINSTALL" ]; then
  [ -n "$SERVICE" ] && { systemctl disable --now boardd.service 2>/dev/null || true; rm -f /etc/systemd/system/boardd.service; systemctl daemon-reload; }
  rm -f "$BIN/boardlab" "$BIN/boards"; rm -rf "$PREFIX"
  [ -n "$PURGE" ] && rm -rf "$STATE"
  say "boardlab removed${PURGE:+ with its state}"; exit 0
fi

# Node >= 24. On RISC-V, Node's Sparkplug compiler crashes some cores: off there, from the first run on.
FLAGS=""; [ "$(uname -m)" = riscv64 ] && FLAGS="--no-sparkplug"
NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/node/bin/node "$PREFIX/node/bin/node"; do
  [ -n "$n" ] && [ -x "$n" ] && [ "$("$n" $FLAGS -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ] && { NODE=$n; break; }
done
if [ -z "$NODE" ]; then
  case $(uname -m) in x86_64) NA=x64; NB=https://nodejs.org/dist ;; aarch64) NA=arm64; NB=https://nodejs.org/dist ;; riscv64) NA=riscv64; NB=https://unofficial-builds.nodejs.org/download/release ;; *) die "no Node >= 24 here and none to fetch for $(uname -m): install it" ;; esac
  V=${BOARDLAB_NODE:-v24.13.0}; [ "$NA" = riscv64 ] && V=${BOARDLAB_NODE:-v24.11.1}
  say "fetching Node $V for $(uname -m)"
  mkdir -p "$PREFIX/node"
  curl -fsSL "$NB/$V/node-$V-linux-$NA.tar.xz" | tar -xJ -C "$PREFIX/node" --strip-components=1 || die "could not fetch Node $V"
  NODE=$PREFIX/node/bin/node
fi

# The release: a tarball by URL or path, a directory holding release.json, or the release this script came from.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fetch() { case $1 in http://*|https://*) curl -fsSL "$1" -o "$2" ;; *) cp "$1" "$2" ;; esac; }
SRC=${FROM:-$BASE}
[ -n "$SRC" ] || die "say where the release is: --from <url|file>, or BOARDLAB_RELEASE=<url>"
case $SRC in
  *.git|*.git\#*|git@*|ssh://*|git+*)
     REPO=${SRC%%#*}; REPO=${REPO#git+}; BRANCH=release; case $SRC in *\#*) BRANCH=${SRC#*#} ;; esac
     command -v git >/dev/null || die "git is needed to fetch $REPO"
     git clone -q --depth 1 -b "$BRANCH" "$REPO" "$TMP/git" || die "could not fetch branch $BRANCH of $REPO"
     FILE=$(sed -n 's/.*"file": *"\([^"]*\)".*/\1/p' "$TMP/git/release.json"); SUM=$(sed -n 's/.*"sha256": *"\([^"]*\)".*/\1/p' "$TMP/git/release.json")
     cp "$TMP/git/$FILE" "$TMP/boardlab.tar.gz"
     [ "$(sha256sum "$TMP/boardlab.tar.gz" | cut -d' ' -f1)" = "$SUM" ] || die "the tarball's sha256 does not match release.json" ;;
  *.tar.gz) fetch "$SRC" "$TMP/boardlab.tar.gz" ;;
  *) SRC=${SRC%/}; fetch "$SRC/release.json" "$TMP/release.json"
     FILE=$(sed -n 's/.*"file": *"\([^"]*\)".*/\1/p' "$TMP/release.json"); SUM=$(sed -n 's/.*"sha256": *"\([^"]*\)".*/\1/p' "$TMP/release.json")
     fetch "$SRC/$FILE" "$TMP/boardlab.tar.gz"
     [ "$(sha256sum "$TMP/boardlab.tar.gz" | cut -d' ' -f1)" = "$SUM" ] || die "the tarball's sha256 does not match release.json" ;;
esac
mkdir -p "$TMP/x"; tar -xzf "$TMP/boardlab.tar.gz" -C "$TMP/x"
DIR=$(ls -d "$TMP"/x/boardlab-* | head -1); VERSION=$(cat "$DIR/VERSION"); REV=$(cat "$DIR/REVISION")
NOW=$(readlink -f "$PREFIX/current" 2>/dev/null || true)
if [ -n "$NOW" ] && [ "$(cat "$NOW/REVISION" 2>/dev/null)" = "$REV" ] && [ -z "$FORCE" ]; then say "boardlab $VERSION ($REV) is already installed"; exit 0; fi
say "installing boardlab $VERSION ($REV) in $PREFIX"
mkdir -p "$PREFIX/releases" "$STATE" "$BIN"
rm -rf "$PREFIX/releases/$VERSION-$REV"; mv "$DIR" "$PREFIX/releases/$VERSION-$REV"
# Where updates come from: the release this came from (boardd checks it, `boardlab update` installs from it).
case $SRC in *.tar.gz) ;; *) printf '%s\n' "$SRC" > "$PREFIX/release-source" ;; esac
# Replaced by a rename, never written over: this very script may be the one running (sh reads it as it goes).
cp "$PREFIX/releases/$VERSION-$REV/install.sh" "$PREFIX/install.sh.new" 2>/dev/null && mv -f "$PREFIX/install.sh.new" "$PREFIX/install.sh" || true
# On a service install, `boardlab` on this machine talks to the service's boardd (its state directory's socket).
printf '%s\n' '#!/bin/sh' ${SERVICE:+": \${BOARDS_STATE_DIR:=$STATE}; export BOARDS_STATE_DIR"} "exec $NODE $FLAGS \"$PREFIX/current/dist/cli.js\" \"\$@\"" > "$BIN/boardlab"; chmod 755 "$BIN/boardlab"; ln -sf boardlab "$BIN/boards"

if [ -n "$SERVICE" ]; then
  # Swap in the new version once no board is locked (a running boardd answers; a stopped one has nothing to wait for).
  if systemctl is-active -q boardd.service 2>/dev/null; then
    for i in $(seq 1 60); do
      held=$(curl -fsS -m 5 -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/state" 2>/dev/null | "$NODE" $FLAGS -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{console.log(JSON.parse(t).boards.filter(x=>x.lease).length)}catch{console.log(0)}})' 2>/dev/null || echo 0)
      [ "$held" = 0 ] && break
      [ "$i" = 1 ] && say "$held board(s) locked: waiting for them to be released (up to 10 minutes; --force to not wait)"
      [ -n "$FORCE" ] && break
      sleep 10
    done
  fi
  ln -sfn "releases/$VERSION-$REV" "$PREFIX/current.new" && mv -Tf "$PREFIX/current.new" "$PREFIX/current"
  [ -f "$STATE/boardd.json" ] || printf '%s\n' '{ "modules": { "bsp": {}, "system": {}, "terminal": { "enabled": true } } }' > "$STATE/boardd.json"
  # Updating from a release that had no system module: add it, so updates show on the page.
  grep -q '"system"' "$STATE/boardd.json" || sed -i 's/"modules": *{/"modules": { "system": {},/' "$STATE/boardd.json"
  cat > /etc/systemd/system/boardd.service <<EOF
[Unit]
Description=boardd: the board lab (boardlab $VERSION)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE $FLAGS $PREFIX/current/dist/cli.js serve --port $PORT --state-dir $STATE --config $STATE/boardd.json$HOSTS$ORIGIN
Environment=NODE_NO_WARNINGS=1
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload; systemctl enable -q boardd.service; systemctl restart boardd.service
  for i in $(seq 1 30); do curl -fsS -m 2 -o /dev/null -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/state" 2>/dev/null && break; sleep 1; done
  ls -1dt "$PREFIX"/releases/* | tail -n +4 | xargs -r rm -rf
  say "boardd $VERSION is up: http://127.0.0.1:$PORT/ (on this machine; open it from elsewhere with --host <address> or through a proxy)"
  say "next, on the page: Settings → bsp 板卡主机 → 添加板卡主机"
else
  ln -sfn "releases/$VERSION-$REV" "$PREFIX/current.new" && mv -Tf "$PREFIX/current.new" "$PREFIX/current"
  say "boardlab $VERSION CLI is in $BIN (add it to PATH); point it at a boardd: boardlab remote set ssh://user@boardd-host"
fi
