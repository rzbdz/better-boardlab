#!/bin/sh
# Install or update boardlab on this machine, in one step:
#
#   curl -fsSL <release>/install.sh | sh                       # the release this script came with
#   curl -fsSL <release>/install.sh | sh -s -- --from <source>   # another release
#   sh install.sh --uninstall [--purge]
#
# A source is a release directory (URL or path, holding release.json and the tarball), a tarball, a git repository
# with the release on a branch (`git@host:group/repo.git#release`, for a server only reachable over ssh), or a git
# server's project API with the release on a branch (`https://git.example/api/v4/projects/<id>#release`), where a private
# project takes a token (--token or BOARDLAB_TOKEN; kept, readable by this user only, for updates):
#
#   curl -fsSL -H "PRIVATE-TOKEN: $T" "https://git.example/api/v4/projects/<id>/repository/files/install.sh/raw?ref=release" \
#     | BOARDLAB_TOKEN=$T sh
#
# As root it sets boardlab up as a service: the program in /opt/boardlab (releases/<version>, `current` links the one in
# use), state in /var/lib/boardlab, the `boardd` systemd unit, and `boardlab` on PATH. As another user it installs only
# the CLI under ~/.local (so does --cli, as root too). Updating swaps `current` and restarts boardd once no board is locked; the state, boardd.json
# and the page's settings are kept. Node >= 24 comes from --node (a node binary, a Node tarball, or its URL), PATH,
# /opt/node, or is fetched from nodejs.org, else from a mirror (BOARDLAB_NODE_MIRROR, npmmirror.com by default).
set -eu
BASE=${BOARDLAB_RELEASE:-@RELEASE_SOURCE@}
case $BASE in @*) BASE="" ;; esac
FROM="" UNINSTALL="" PURGE="" PORT=38127 HOSTS="" ORIGIN="" FORCE="" NODE_GIVEN="" TOKEN=${BOARDLAB_TOKEN:-} CLI_ONLY=""
while [ $# -gt 0 ]; do
  case $1 in
    --from) FROM=$2; shift 2 ;; --port) PORT=$2; shift 2 ;; --host) HOSTS="$HOSTS --host $2"; shift 2 ;; --origin) ORIGIN="$ORIGIN --origin $2"; shift 2 ;;
    --node) NODE_GIVEN=$2; shift 2 ;; --token) TOKEN=$2; shift 2 ;; --cli) CLI_ONLY=1; shift ;; --uninstall) UNINSTALL=1; shift ;; --purge) PURGE=1; shift ;; --force) FORCE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say() { printf '==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" = 0 ] && [ -z "$CLI_ONLY" ]; then PREFIX=/opt/boardlab STATE=/var/lib/boardlab BIN=/usr/local/bin SERVICE=1; else PREFIX=$HOME/.local/share/boardlab STATE=$HOME/.local/state/boardlab BIN=$HOME/.local/bin SERVICE=""; fi
# How boardd was set up the first time (port, extra addresses, the proxy's origin): an update keeps it unless told
# otherwise.
OFFERED=""
if [ -f "$STATE/install.env" ]; then
  GIVEN_PORT=$PORT GIVEN_HOSTS=$HOSTS GIVEN_ORIGIN=$ORIGIN
  . "$STATE/install.env"
  [ "$GIVEN_PORT" != 38127 ] && PORT=$GIVEN_PORT
  [ -n "$GIVEN_HOSTS" ] && HOSTS=$GIVEN_HOSTS
  [ -n "$GIVEN_ORIGIN" ] && ORIGIN=$GIVEN_ORIGIN
fi

# The token a private release source takes, kept from the first install.
[ -z "$TOKEN" ] && [ -r "$PREFIX/release-token" ] && TOKEN=$(cat "$PREFIX/release-token")

if [ -n "$UNINSTALL" ]; then
  [ -n "$SERVICE" ] && { systemctl disable --now boardd.service 2>/dev/null || true; rm -f /etc/systemd/system/boardd.service; systemctl daemon-reload; }
  rm -f "$BIN/boardlab" "$BIN/boards"; rm -rf "$PREFIX"
  [ -n "$PURGE" ] && rm -rf "$STATE"
  say "boardlab removed${PURGE:+ with its state}"; exit 0
fi

# Node >= 24. On RISC-V, Node's Sparkplug compiler crashes some cores: off there, from the first run on.
FLAGS=""; [ "$(uname -m)" = riscv64 ] && FLAGS="--no-sparkplug"
NODE=""
node_ok() { [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" $FLAGS -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]; }
# A Node tarball (path or URL) unpacked as this install's own Node.
unpack_node() {
  rm -rf "$PREFIX/node.new"; mkdir -p "$PREFIX/node.new"
  case $1 in
    http://*|https://*) curl -fsSL --connect-timeout 15 "$1" ;;
    *) cat "$1" ;;
  esac | case $1 in *.tar.gz|*.tgz) tar -xz -C "$PREFIX/node.new" --strip-components=1 ;; *) tar -xJ -C "$PREFIX/node.new" --strip-components=1 ;; esac 2>/dev/null \
    && node_ok "$PREFIX/node.new/bin/node" && rm -rf "$PREFIX/node" && mv "$PREFIX/node.new" "$PREFIX/node"
}
if [ -n "$NODE_GIVEN" ]; then
  case $NODE_GIVEN in
    *.tar.xz|*.tar.gz|*.tgz) mkdir -p "$PREFIX"; unpack_node "$NODE_GIVEN" || die "--node $NODE_GIVEN: not a Node >= 24 tarball for this machine" ;;
    *) node_ok "$NODE_GIVEN" || die "--node $NODE_GIVEN: not a Node >= 24 that runs here"
       mkdir -p "$PREFIX/node/bin"; [ "$NODE_GIVEN" -ef "$PREFIX/node/bin/node" ] || cp "$NODE_GIVEN" "$PREFIX/node/bin/node.new"; [ -f "$PREFIX/node/bin/node.new" ] && mv -f "$PREFIX/node/bin/node.new" "$PREFIX/node/bin/node" ;;
  esac
fi
for n in "$PREFIX/node/bin/node" "$(command -v node 2>/dev/null || true)" /opt/node/bin/node; do
  node_ok "$n" && { NODE=$n; break; }
done
if [ -z "$NODE" ]; then
  case $(uname -m) in
    x86_64) NA=x64; NB="https://nodejs.org/dist ${BOARDLAB_NODE_MIRROR:-https://npmmirror.com/mirrors/node}" ;;
    aarch64) NA=arm64; NB="https://nodejs.org/dist ${BOARDLAB_NODE_MIRROR:-https://npmmirror.com/mirrors/node}" ;;
    riscv64) NA=riscv64; NB="https://unofficial-builds.nodejs.org/download/release ${BOARDLAB_NODE_MIRROR:-}" ;;
    *) die "no Node >= 24 here and none to fetch for $(uname -m): install one, or give it with --node <path|tarball>" ;;
  esac
  V=${BOARDLAB_NODE:-v24.13.0}; [ "$NA" = riscv64 ] && V=${BOARDLAB_NODE:-v24.11.1}
  mkdir -p "$PREFIX"
  for base in $NB; do
    say "fetching Node $V for $(uname -m) from $base"
    unpack_node "$base/$V/node-$V-linux-$NA.tar.xz" && { NODE=$PREFIX/node/bin/node; break; }
  done
  [ -n "$NODE" ] || die "could not fetch Node $V (no internet here?): copy a Node >= 24 for $(uname -m) and run again with --node <path to node or its tarball>"
fi

# The release: a tarball by URL or path, a directory holding release.json, or the release this script came from.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fetch() { case $1 in http://*|https://*) curl -fsSL --connect-timeout 15 "$1" -o "$2" ;; *) cp "$1" "$2" ;; esac; }
# The token goes only to the project API the source names.
fetch_api() { if [ -n "$TOKEN" ]; then curl -fsSL --connect-timeout 15 -H "PRIVATE-TOKEN: $TOKEN" "$1" -o "$2"; else curl -fsSL --connect-timeout 15 "$1" -o "$2"; fi; }
# The release's files: from a directory, or through a project API from the release branch.
release_file() {
  case $SRC in
    */api/v4/projects/*) API=${SRC%%#*}; REF=release; case $SRC in *\#*) REF=${SRC#*#} ;; esac
       HOW="with the token given"; [ -n "$TOKEN" ] || HOW="without a token (a private project needs --token)"
       fetch_api "$API/repository/files/$1/raw?ref=$REF" "$2" || die "could not fetch $1 from $API, branch $REF, $HOW" ;;
    *) fetch "$SRC/$1" "$2" || die "could not fetch $SRC/$1" ;;
  esac
}
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
  *) SRC=${SRC%/}; release_file release.json "$TMP/release.json"
     FILE=$(sed -n 's/.*"file": *"\([^"]*\)".*/\1/p' "$TMP/release.json"); SUM=$(sed -n 's/.*"sha256": *"\([^"]*\)".*/\1/p' "$TMP/release.json")
     release_file "$FILE" "$TMP/boardlab.tar.gz"
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
if [ -n "$TOKEN" ]; then (umask 077; printf '%s\n' "$TOKEN" > "$PREFIX/release-token"); fi
# Replaced by a rename, never written over: this very script may be the one running (sh reads it as it goes).
cp "$PREFIX/releases/$VERSION-$REV/install.sh" "$PREFIX/install.sh.new" 2>/dev/null && mv -f "$PREFIX/install.sh.new" "$PREFIX/install.sh" || true
# On a service install, `boardlab` on this machine talks to the service's boardd (its state directory's socket).
printf '%s\n' '#!/bin/sh' ${SERVICE:+": \${BOARDS_STATE_DIR:=$STATE}; export BOARDS_STATE_DIR"} "exec $NODE $FLAGS \"$PREFIX/current/dist/cli.js\" \"\$@\"" > "$BIN/boardlab"; chmod 755 "$BIN/boardlab"; ln -sf boardlab "$BIN/boards"

# boardd's config, made on the first install. Modules a release brings (updates and CLI machines on the page) are added
# to an existing one once, by the first update that has them: one taken out afterwards stays out. OFFERED (kept in
# install.env): those offered already.
OFFER="system clients"
offer_modules() {
  if [ ! -f "$STATE/boardd.json" ]; then
    printf '%s\n' '{ "modules": { "bsp": {}, "system": {}, "clients": {}, "terminal": { "enabled": true } } }' > "$STATE/boardd.json"
    OFFERED=$OFFER; return 0
  fi
  for m in $OFFER; do
    case " $OFFERED " in *" $m "*) continue ;; esac
    if "$NODE" $FLAGS -e '
      const fs = require("fs"), [file, id] = process.argv.slice(1), config = JSON.parse(fs.readFileSync(file, "utf8"))
      const isMap = value => value !== null && typeof value === "object" && !Array.isArray(value)
      if (!isMap(config)) process.exit(1)
      config.modules ??= {}
      if (!isMap(config.modules)) process.exit(1)
      if (!(id in config.modules)) {
        config.modules[id] = {}
        fs.writeFileSync(file + ".new", JSON.stringify(config, null, 2) + "\n", { mode: fs.statSync(file).mode & 0o777 })
        fs.renameSync(file + ".new", file)
      }' "$STATE/boardd.json" "$m" 2>/dev/null; then OFFERED="${OFFERED:+$OFFERED }$m"
    else say "could not add the $m module to $STATE/boardd.json (not a JSON object with \"modules\"?): add it there by hand"; fi
  done
}

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
  offer_modules
  printf 'PORT=%s\nHOSTS="%s"\nORIGIN="%s"\nOFFERED="%s"\n' "$PORT" "$HOSTS" "$ORIGIN" "$OFFERED" > "$STATE/install.env"
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
  command -v python3 >/dev/null || say "WARNING: no python3 here: the bsp module (board hosts, SDKs) runs the bsp CLI with it; install python3"
  command -v ssh >/dev/null || say "WARNING: no ssh client here: boardd reaches board hosts and CLI machines with it; install openssh-client"
  say "next, on the page: Settings → bsp 板卡主机 → 添加板卡主机"
else
  ln -sfn "releases/$VERSION-$REV" "$PREFIX/current.new" && mv -Tf "$PREFIX/current.new" "$PREFIX/current"
  say "boardlab $VERSION CLI is in $BIN (add it to PATH); point it at a boardd: boardlab remote set ssh://user@boardd-host"
fi
