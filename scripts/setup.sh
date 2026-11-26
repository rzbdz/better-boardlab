#!/bin/sh
# Install or update boardlab on this machine from a release install.sh has fetched and unpacked: install.sh runs the
# setup.sh of the release it installs, with every option it was given and
#
#   --source <where the release came from>   kept for updates (not for a tarball)
#   --unpacked <the release's directory>     boardlab-<version>/, moved into place
#
#   sh setup.sh --uninstall [--purge]
#
# --core-dumps (kept for updates; --no-core-dumps turns it off): boardd runs in <state>/cores with core files allowed
# (up to 1 GB each), so a crashed worker leaves one there when the kernel's core_pattern is a plain `core`; the
# supervisor keeps the newest two, named after the worker.
#
# As root it sets boardlab up as a service: the program in /opt/boardlab (releases/<version>, `current` links the one in
# use), state in /var/lib/boardlab, the `boardd` systemd unit, and `boardlab` on PATH. As another user it installs only
# the CLI under ~/.local (so does --cli, as root too). Updating swaps `current` and restarts boardd once no board is
# locked; the state, boardd.json and the page's settings are kept. Node >= 24 comes from --node (a node binary, a Node
# tarball, or its URL), PATH, /opt/node, or is fetched from nodejs.org, else from a mirror (BOARDLAB_NODE_MIRROR,
# npmmirror.com by default). A private source's token (--token or BOARDLAB_TOKEN) is kept, readable by this user only.
set -eu
SRC="" UNPACKED="" UNINSTALL="" PURGE="" PORT=38127 HOSTS="" ORIGIN="" FORCE="" NODE_GIVEN="" TOKEN=${BOARDLAB_TOKEN:-} CLI_ONLY="" CORES_GIVEN=""
while [ $# -gt 0 ]; do
  case $1 in
    --source) SRC=$2; shift 2 ;; --unpacked) UNPACKED=$2; shift 2 ;; --from) shift 2 ;; --port) PORT=$2; shift 2 ;; --host) HOSTS="$HOSTS --host $2"; shift 2 ;; --origin) ORIGIN="$ORIGIN --origin $2"; shift 2 ;;
    --node) NODE_GIVEN=$2; shift 2 ;; --token) TOKEN=$2; shift 2 ;; --cli) CLI_ONLY=1; shift ;; --uninstall) UNINSTALL=1; shift ;; --purge) PURGE=1; shift ;; --force) FORCE=1; shift ;;
    --core-dumps) CORES_GIVEN=1; shift ;; --no-core-dumps) CORES_GIVEN=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say() { printf '==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" = 0 ] && [ -z "$CLI_ONLY" ]; then PREFIX=/opt/boardlab STATE=/var/lib/boardlab BIN=/usr/local/bin SERVICE=1; else PREFIX=$HOME/.local/share/boardlab STATE=$HOME/.local/state/boardlab BIN=$HOME/.local/bin SERVICE=""; fi
# How boardd was set up the first time (port, extra addresses, the proxy's origin): an update keeps it unless told
# otherwise.
OFFERED="" CORES=""
if [ -f "$STATE/install.env" ]; then
  GIVEN_PORT=$PORT GIVEN_HOSTS=$HOSTS GIVEN_ORIGIN=$ORIGIN
  . "$STATE/install.env"
  [ "$GIVEN_PORT" != 38127 ] && PORT=$GIVEN_PORT
  [ -n "$GIVEN_HOSTS" ] && HOSTS=$GIVEN_HOSTS
  [ -n "$GIVEN_ORIGIN" ] && ORIGIN=$GIVEN_ORIGIN
fi
[ "$CORES_GIVEN" = 1 ] && CORES=1
[ "$CORES_GIVEN" = 0 ] && CORES=""

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

# The release, unpacked by install.sh.
[ -n "$UNPACKED" ] && [ -f "$UNPACKED/VERSION" ] || die "setup.sh installs a release install.sh has unpacked: run install.sh --from <source>"
DIR=$UNPACKED; VERSION=$(cat "$DIR/VERSION"); REV=$(cat "$DIR/REVISION")
# Every release carries VERSION and REVISION; they are checked before either becomes part of a path. A package.json
# (new packages) must agree with them; historical packages without one remain installable. The bootstrap preserves a
# managed source's release.json for this check but does not interpret new fields itself.
"$NODE" $FLAGS - "$DIR" <<'NODE' || exit 1
const fs = require('fs')
const path = require('path')
const root = process.argv[2]
const fail = message => { console.error(`!! ${message}`); process.exit(1) }
const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8').trim() } catch { return '' } }
const version = read('VERSION'), revision = read('REVISION')
if (!/^0\.\d+\.\d+(?:rc[1-9]\d*)?$/.test(version)) fail('release VERSION is missing or invalid')
// New packages carry the full revision; historical ones used a short hexadecimal one, which is just as safe in paths.
const manifestFile = path.join(root, 'package.json')
const full = fs.existsSync(manifestFile)
if (!(full ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{7,40}$/).test(revision)) fail(full ? 'release REVISION is missing or not a full source revision' : 'release REVISION is missing or not a source revision')
const expected = `boardlab-${version}.tar.gz`
if (path.basename(root) !== `boardlab-${version}` && path.basename(root) !== `${version}-${revision}`) {
  fail(`release directory does not match VERSION (expected ${expected})`)
}
if (fs.existsSync(manifestFile)) {
  let manifest
  try { manifest = JSON.parse(read('package.json')) } catch { fail('release package.json is not valid JSON') }
  if (manifest.name !== 'boardlab' || manifest.version !== version) fail('release package.json does not match VERSION')
}
const sourceFile = path.join(root, '.release-source.json')
if (fs.existsSync(sourceFile)) {
  let source
  try { source = JSON.parse(fs.readFileSync(sourceFile, 'utf8')) } catch { fail('managed release.json is not valid JSON') }
  if (source.version !== version || source.revision !== revision || source.file !== expected) {
    fail('managed release.json does not match the unpacked release identity')
  }
}
NODE
rm -f "$DIR/.release-source.json"
NOW=$(readlink -f "$PREFIX/current" 2>/dev/null || true)
if [ -n "$NOW" ] && [ "$(cat "$NOW/REVISION" 2>/dev/null)" = "$REV" ] && [ -z "$FORCE" ]; then say "boardlab $VERSION ($REV) is already installed"; exit 0; fi
say "installing boardlab $VERSION ($REV) in $PREFIX"
mkdir -p "$PREFIX/releases" "$STATE" "$BIN"
rm -rf "$PREFIX/releases/$VERSION-$REV"; mv "$DIR" "$PREFIX/releases/$VERSION-$REV"
# Where updates come from: the release this came from (boardd checks it, `boardlab update` installs from it).
case $SRC in ""|*.tar.gz|*.tgz) ;; *) printf '%s\n' "$SRC" > "$PREFIX/release-source" ;; esac
if [ -n "$TOKEN" ]; then (umask 077; printf '%s\n' "$TOKEN" > "$PREFIX/release-token"); fi
# What updates run (install.sh --from <release-source>): the release's own install.sh. Replaced by a rename, never
# written over: it may be the one running (sh reads it as it goes).
cp "$PREFIX/releases/$VERSION-$REV/install.sh" "$PREFIX/install.sh.new" 2>/dev/null && mv -f "$PREFIX/install.sh.new" "$PREFIX/install.sh" || true
# On a service install, `boardlab` on this machine talks to the service's boardd (its state directory's socket).
printf '%s\n' '#!/bin/sh' ${SERVICE:+": \${BOARDS_STATE_DIR:=$STATE}; export BOARDS_STATE_DIR"} "exec $NODE $FLAGS \"$PREFIX/current/dist/cli.js\" \"\$@\"" > "$BIN/boardlab"; chmod 755 "$BIN/boardlab"; ln -sf boardlab "$BIN/boards"

# boardd's config, made on the first install. Modules a release brings (updates and CLI machines on the page) are added
# to an existing one once, by the first update that has them: one taken out afterwards stays out. OFFERED (kept in
# install.env): those offered already. The named ones come from the public market (offer_market) or are this
# distribution's own catalogs; `market` is the module market's own page, which a machine that has a market needs to see it.
OFFER="system clients feedback alerts console-watch market human sftp-images terminal boardlab"
# Modules this distribution adds on top: listed in modules.offered of the release, absent from the public one.
if [ -f "$PREFIX/releases/$VERSION-$REV/dist/modules.offered" ]; then OFFER="$OFFER $(cat "$PREFIX/releases/$VERSION-$REV/dist/modules.offered")"; fi
# The public module market, and the modules this distribution is assembled from that live in it. A machine that already
# has its own boardd.json keeps it: the modules are added there once (`offer_modules`), and the market is added only if
# this machine has none yet (a machine with markets of its own is left as its owner set it up).
PUB_MARKET_URL="git@github.com:rzbdz/boardlab-modules-pub.git"
offer_market() {
  "$NODE" $FLAGS -e '
    const fs = require("fs"), [state, url] = process.argv.slice(1)
    const file = state + "/markets.json"
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { markets: [] }
    if (!Array.isArray(current.markets)) process.exit(1)
    if (current.markets.length) process.exit(0)
    fs.writeFileSync(file, JSON.stringify({ markets: [{ id: "pub", url, branch: null, commit: null }] }, null, 2) + "\n")
    console.log("added the pub module market: boardd fetches it at its next start")' "$STATE" "$PUB_MARKET_URL" 2>/dev/null \
    || say "could not record the pub module market in $STATE/markets.json (add it with: boardlab market add pub $PUB_MARKET_URL)"
}
# A module a market brings is the machine's own choice (boardlab market add, then its name in boardd.json): it is left
# as a person set it, including when a market no longer offers it (boardd says so at start, and does not remove it).
offer_modules() {
  if [ ! -f "$STATE/boardd.json" ]; then
    printf '%s\n' '{ "modules": { "boardctrl": {}, "system": {}, "clients": {}, "terminal": { "enabled": true }, "feedback": {}, "alerts": {}, "console-watch": {}, "market": {}, "human": {}, "sftp-images": {} } }' > "$STATE/boardd.json"
    OFFERED=$OFFER; offer_market; return 0
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
  # A machine with no market of its own gets the pub one, so its modules have somewhere to come from; one that has any
  # (its site's, a vendor's) keeps exactly what its owner set up.
  offer_market
}

if [ -n "$SERVICE" ]; then
  # A boardd under a supervisor hands over to the new release without a restart: new connections go to it, the old
  # worker keeps its consoles, streams and running tasks until they end. Nothing waits for locks then.
  SUPERVISED=""
  SUPERVISOR=$(cat "$STATE/supervisor.pid" 2>/dev/null || true)
  if [ -n "$SUPERVISOR" ] && kill -0 "$SUPERVISOR" 2>/dev/null && systemctl is-active -q boardd.service 2>/dev/null; then SUPERVISED=$SUPERVISOR; fi
  # One boardd, older than this feature: swap and restart once no board is locked.
  if [ -z "$SUPERVISED" ] && systemctl is-active -q boardd.service 2>/dev/null; then
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
  printf 'PORT=%s\nHOSTS="%s"\nORIGIN="%s"\nOFFERED="%s"\nCORES="%s"\n' "$PORT" "$HOSTS" "$ORIGIN" "$OFFERED" "$CORES" > "$STATE/install.env"
  # Core files of crashed workers, when asked for: boardd runs in their directory (see --core-dumps).
  CORE_UNIT=""
  if [ -n "$CORES" ]; then
    mkdir -p "$STATE/cores"; chmod 700 "$STATE/cores"
    CORE_UNIT="WorkingDirectory=$STATE/cores
LimitCORE=1G"
    case $(cat /proc/sys/kernel/core_pattern 2>/dev/null) in core|core.*) ;; *) say "core dumps: kernel.core_pattern is not a plain 'core' here, so crashed workers' cores go where it says, not to $STATE/cores" ;; esac
  fi
  # What the running supervisor was started with, but for the release named in its description.
  UNIT_BEFORE=$(grep -v '^Description=' /etc/systemd/system/boardd.service 2>/dev/null || true)
  cat > /etc/systemd/system/boardd.service <<EOF
[Unit]
Description=boardd: the board lab (boardlab $VERSION)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE $FLAGS $PREFIX/current/dist/cli.js serve --supervisor --port $PORT --state-dir $STATE --config $STATE/boardd.json$HOSTS$ORIGIN
Environment=NODE_NO_WARNINGS=1
$CORE_UNIT
Restart=always
RestartSec=2
# A restart is the last resort (an update hands over instead): the browser terminals (tmux sessions) and what is
# running on the boards are not boardd's to end.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload; systemctl enable -q boardd.service
  if [ -n "$SUPERVISED" ]; then
    say "handing over to boardlab $VERSION ($REV) without stopping boardd"
    printf '{"release":"%s","version":"%s","revision":"%s"}\n' "$PREFIX/releases/$VERSION-$REV" "$VERSION" "$REV" > "$STATE/update.json"
    kill -USR2 "$SUPERVISED" 2>/dev/null || SUPERVISED=""
    if [ -n "$SUPERVISED" ]; then
      serving=""
      for i in $(seq 1 90); do
        serving=$("$NODE" $FLAGS -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)}catch{}' "$STATE/serving.json" 2>/dev/null || true)
        [ "$serving" = "$REV" ] && break
        sleep 1
      done
      [ "$serving" = "$REV" ] || { say "the supervisor did not hand over in time; restarting boardd"; rm -f "$STATE/update.json"; SUPERVISED=""; }
    fi
  fi
  [ -z "$SUPERVISED" ] && systemctl restart boardd.service
  # A handover keeps the supervisor, so a changed unit (node, its flags, core dumps, the port) waits for its next start.
  if [ -n "$SUPERVISED" ] && [ "$UNIT_BEFORE" != "$(grep -v '^Description=' /etc/systemd/system/boardd.service)" ]; then
    say "the boardd unit changed; it takes effect at the next 'systemctl restart boardd' (do it while no board is locked)"
  fi
  for i in $(seq 1 30); do curl -fsS -m 2 -o /dev/null -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/state" 2>/dev/null && break; sleep 1; done
  # The release just installed may have been built earlier than the ones already here: its install time decides.
  touch "$PREFIX/releases/$VERSION-$REV"
  ls -1dt "$PREFIX"/releases/* | grep -vxF "$PREFIX/releases/$VERSION-$REV" | tail -n +3 | xargs -r rm -rf
  say "boardd $VERSION is up: http://127.0.0.1:$PORT/ (on this machine; open it from elsewhere with --host <address> or through a proxy)"
  command -v python3 >/dev/null || say "WARNING: no python3 here: the boardctrl module (board hosts, SDKs) runs the boardctrl CLI with it; install python3"
  command -v ssh >/dev/null || say "WARNING: no ssh client here: boardd reaches board hosts and CLI machines with it; install openssh-client"
  say "next, on the page: Settings → boardctrl 板卡主机 → 添加板卡主机"
else
  ln -sfn "releases/$VERSION-$REV" "$PREFIX/current.new" && mv -Tf "$PREFIX/current.new" "$PREFIX/current"
  say "boardlab $VERSION CLI is in $BIN (add it to PATH); point it at a boardd: boardlab remote set ssh://user@boardd-host"
fi
# The boardlab skill for the AI agents this user has set up (Claude Code, Codex, OpenCode, ...): `boardlab install -g`
# writes it where each reads skills, so every update brings the skill of the release it installs. No agent: nothing.
"$BIN/boardlab" install -g 2>/dev/null | sed 's/^/==> /' || true
