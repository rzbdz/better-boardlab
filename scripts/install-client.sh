#!/usr/bin/env bash
# Install (or update) the boardlab CLI and its agent skill on a compile machine (a build server, a laptop), set up to
# use the central boardd. Compile machines need nothing else: boards, SDK trees and builds are all reached through
# boardlab, and only boardd's machine runs the bsp CLI.
#
#   scripts/install-client.sh <user@host|local> --remote <url> [--user NAME] [--grant ADMIN@BOARDD_HOST] [--allow-dirty]
#
#   --remote URL    the boardd to use: ssh://boardlab@boardd-host (networks that only let ssh through) or
#                   https://host/boardlab/ (through the proxy serving its page; add --user and type the password)
#   --user NAME     who you are on that boardd (default: the login on the target)
#   --grant A@H     with an ssh:// remote: add the target's ssh key to the tunnel account on the boardd host, as
#                   admin A@H, restricted to forwarding to boardd's port (restrict,port-forwarding,permitopen)
#
# Installs to ~/.local/share/boardlab, with ~/.local/bin/boardlab and the alias ~/.local/bin/boards. boardlab needs
# Node >= 24; a target without it gets one under ~/.local/share/boardlab/node (fetched here, so the target needs no
# internet). Agents get the skill where they work: `boardlab install` writes it into the current directory.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=${1:?usage: scripts/install-client.sh <user@host|local> --remote <url> [--user NAME] [--grant ADMIN@HOST]}
shift
REMOTE="" USER_NAME="" GRANT="" ALLOW_DIRTY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --remote) REMOTE=$2; shift 2 ;;
    --user) USER_NAME=$2; shift 2 ;;
    --grant) GRANT=$2; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=--allow-dirty; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -n $REMOTE ]] || { echo "--remote is required (ssh://boardlab@host or https://host/boardlab/)" >&2; exit 2; }
NODE_VERSION=${BOARDS_NODE_VERSION:-v24.13.0}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
on() { if [[ $TARGET == local ]]; then bash -c "$1"; else "${SSH[@]}" "$TARGET" "$1"; fi; }
feed() { if [[ $TARGET == local ]]; then bash -c "$1"; else "${SSH[@]}" "$TARGET" "$1"; fi; }

REV=$(git rev-parse --short HEAD)
[[ -z $(git status --porcelain --untracked-files=no -- src skills) ]] || [[ -n $ALLOW_DIRTY ]] || { echo "uncommitted changes in src/ or skills/; commit or pass --allow-dirty" >&2; exit 1; }
[[ -f dist/cli.js ]] || { echo "build first: pnpm install && pnpm run build" >&2; exit 1; }

echo "==> boardlab CLI $REV -> $TARGET"
tar -czf - dist/*.js skills/boardlab | feed "set -e; D=~/.local/share/boardlab; rm -rf \$D/dist \$D/skills; mkdir -p \$D; tar -xzf - -C \$D; echo $REV > \$D/REVISION"

# Node >= 24 (node:sqlite is not needed by the client, but the bundle targets Node 24).
if ! on 'command -v node >/dev/null && [ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 24 ]'; then
  ARCH=$(on 'uname -m')
  case $ARCH in x86_64) NA=x64 ;; aarch64) NA=arm64 ;; *) echo "no Node build for $ARCH here: install Node >= 24 on $TARGET yourself" >&2; exit 1 ;; esac
  F=node-$NODE_VERSION-linux-$NA.tar.xz
  CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/boardlab
  mkdir -p "$CACHE"
  if [[ ! -s $CACHE/$F ]]; then curl -fsSL -o "$CACHE/$F.part" "https://nodejs.org/dist/$NODE_VERSION/$F"; mv -f "$CACHE/$F.part" "$CACHE/$F"; fi
  echo "==> Node $NODE_VERSION for $ARCH (the target's own is older than 24)"
  feed "set -e; D=~/.local/share/boardlab/node; rm -rf \$D; mkdir -p \$D; tar -xJf - -C \$D --strip-components=1" < "$CACHE/$F"
  NODE='$HOME/.local/share/boardlab/node/bin/node'
else
  NODE=node
fi
on "set -e; mkdir -p ~/.local/bin; printf '%s\n' '#!/bin/sh' 'exec $NODE \"\$HOME/.local/share/boardlab/dist/cli.js\" \"\$@\"' > ~/.local/bin/boardlab; chmod +x ~/.local/bin/boardlab; ln -sf boardlab ~/.local/bin/boards"

if [[ -n $GRANT && $REMOTE == ssh://* ]]; then
  TUNNEL=${REMOTE#ssh://}; TUNNEL=${TUNNEL%%/*}; TUNNEL_USER=${TUNNEL%@*}; TUNNEL_USER=${TUNNEL_USER:-boardlab}
  KEY=$(on 'set -e; [ -s ~/.ssh/id_ed25519.pub ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519; cat ~/.ssh/id_ed25519.pub')
  echo "==> allow $TARGET to reach boardd through $TUNNEL_USER@${GRANT#*@}"
  "${SSH[@]}" "$GRANT" "set -e; id $TUNNEL_USER >/dev/null 2>&1 || useradd --create-home --shell /bin/sh $TUNNEL_USER
    H=\$(getent passwd $TUNNEL_USER | cut -d: -f6); mkdir -p \$H/.ssh; touch \$H/.ssh/authorized_keys
    LINE='restrict,port-forwarding,permitopen=\"127.0.0.1:38127\" $KEY'
    grep -qF '$KEY' \$H/.ssh/authorized_keys || echo \"\$LINE\" >> \$H/.ssh/authorized_keys
    chown -R $TUNNEL_USER: \$H/.ssh; chmod 700 \$H/.ssh; chmod 600 \$H/.ssh/authorized_keys"
fi

echo "==> connect to $REMOTE"
if [[ $REMOTE == http* && -n $USER_NAME ]]; then
  read -r -s -p "password for $USER_NAME on $REMOTE: " PASSWORD; echo
  printf '%s' "$PASSWORD" | feed "~/.local/bin/boardlab remote set '$REMOTE' --user '$USER_NAME' --password-stdin"
else
  on "~/.local/bin/boardlab remote set '$REMOTE' ${USER_NAME:+--user '$USER_NAME'}"
fi

echo "==> done: on $TARGET run \`boardlab list\` (~/.local/bin must be on PATH)"
