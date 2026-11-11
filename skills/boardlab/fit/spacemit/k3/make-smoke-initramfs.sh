#!/usr/bin/env bash
# Build a K3 smoke-test initramfs: the SDK's BusyBox rootfs with an /init that reports what the
# kernel found (model, compatible, cmdline, CPUs, memory, partitions, network and MMC hosts) between
# === K3_SMOKE_BEGIN === and === K3_SMOKE_READY ===, then opens a shell on the console. It mounts nothing
# persistent and starts no services.
#
#   make-smoke-initramfs.sh <SDK rootfs .cpio.gz> <new output directory>
#
# The new /init is appended as a second cpio archive, so nothing has to be unpacked as root; the kernel takes the
# later copy. SMOKE_HOST names the build host the files are on (default: none, run here).
set -euo pipefail

host=${SMOKE_HOST-}
if [ $# -ne 2 ]; then
	echo "usage: $(basename "$0") <SDK rootfs .cpio.gz> <new output directory>" >&2
	exit 2
fi

read -r -d '' init <<'INIT' || true
#!/bin/sh
mkdir -p /proc /sys /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev

exec </dev/console >/dev/console 2>&1

echo '=== K3_SMOKE_BEGIN ==='
uname -a
printf 'MODEL='
tr '\000' '\n' </proc/device-tree/model 2>/dev/null || echo
printf 'COMPATIBLE='
tr '\000' ' ' </proc/device-tree/compatible 2>/dev/null || true
echo
printf 'CMDLINE='
cat /proc/cmdline
printf 'CPUS='
grep -c '^processor' /proc/cpuinfo
grep MemTotal /proc/meminfo
echo 'PARTITIONS_BEGIN'
cat /proc/partitions
echo 'PARTITIONS_END'
echo 'NET_INTERFACES_BEGIN'
for netdev in /sys/class/net/*; do
	[ -e "$netdev" ] || continue
	printf '%s ' "${netdev##*/}"
	cat "$netdev/address" 2>/dev/null || echo unknown
done
echo 'NET_INTERFACES_END'
echo 'MMC_HOSTS_BEGIN'
for mmc in /sys/class/mmc_host/*; do
	[ -e "$mmc" ] || continue
	echo "${mmc##*/}"
done
echo 'MMC_HOSTS_END'
echo '=== K3_SMOKE_READY ==='

exec /bin/sh -i
INIT

script='
set -eu
src=$1 out=$2 init=$3
[ -f "$src" ] || { echo "no rootfs at $src" >&2; exit 1; }
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then echo "$out is not empty; pick a new directory" >&2; exit 1; fi
mkdir -p "$out/stage"
printf "%s\n" "$init" >"$out/stage/init"
chmod 0755 "$out/stage/init"
cp "$out/stage/init" "$out/init"
# The kernel only finds the second archive at an aligned offset; zero padding between archives is skipped.
size=$(zcat "$src" | wc -c)
pad=$(( (512 - size % 512) % 512 ))
{ zcat "$src"; head -c "$pad" /dev/zero; (cd "$out/stage" && echo init | cpio -o -H newc -R 0:0 --quiet); } | gzip -9n >"$out/rootfs-smoke.cpio.gz"
rm -r "$out/stage"
# The appended /init must be what follows the SDK archive.
[ "$(zcat "$out/rootfs-smoke.cpio.gz" | tail -c +$((size + pad + 1)) | cpio -i --to-stdout --quiet init | sha256sum)" = "$(sha256sum <"$out/init")" ]
{
	echo "source $src"
	echo "source_sha256 $(sha256sum <"$src" | cut -d" " -f1)"
	echo "init_sha256 $(sha256sum <"$out/init" | cut -d" " -f1)"
	echo "rootfs_sha256 $(sha256sum <"$out/rootfs-smoke.cpio.gz" | cut -d" " -f1)"
	echo "built $(date -Is)"
} >"$out/SOURCE"
cat "$out/SOURCE"
'
if [ -n "$host" ]; then
	ssh "$host" "bash -s -- $(printf '%q ' "$1" "$2" "$init")" <<<"$script"
else
	bash -s -- "$1" "$2" "$init" <<<"$script"
fi
