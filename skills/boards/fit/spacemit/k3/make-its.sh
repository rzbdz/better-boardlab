#!/usr/bin/env bash
# Package a K3 kernel build on the build host as a FIT (Image.itb) for every board in boards.csv.
#
#   make-its.sh <O= directory on the build host> <new artifact directory on the build host>
#
# U-Boot picks the configuration whose description equals the board's EEPROM
# product_name, and falls back to the first row of boards.csv. Image and the
# DTBs are copied into the artifact directory next to Image.its and Image.itb.
# FIT_HOST names the build host (default build; empty runs locally).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
map=${FIT_MAP:-$here/boards.csv}
host=${FIT_HOST-build}

if [ $# -ne 2 ]; then
	echo "usage: $(basename "$0") <O= directory> <new artifact directory>" >&2
	exit 2
fi
obj=$1
out=$2

# Run a shell snippet on the build host; arguments become $1, $2, ...
on_host() {
	local script=$1; shift
	if [ -n "$host" ]; then
		ssh "$host" "bash -s -- $(printf '%q ' "$@")" <<<"$script"
	else
		bash -s -- "$@" <<<"$script"
	fi
}

listing=$(on_host '
set -eu
obj=$1 out=$2
case $out in "$HOME"/k3-sdk|"$HOME"/k3-sdk/*) echo "refusing to write into the SDK: $out" >&2; exit 1 ;; esac
[ -f "$obj/arch/riscv/boot/Image" ] || { echo "no Image in $obj/arch/riscv/boot" >&2; exit 1; }
if [ -e "$out/Image.itb" ] || [ -e "$out/Image.its" ]; then echo "$out already holds a FIT; pick a new directory" >&2; exit 1; fi
echo "release $(cat "$obj/include/config/kernel.release" 2>/dev/null || echo unknown)"
for f in "$obj"/arch/riscv/boot/dts/spacemit/k3*.dtb; do [ -e "$f" ] && echo "dtb ${f##*/}"; done
true
' "$obj" "$out")

release=$(sed -n 's/^release //p' <<<"$listing")
built=$(sed -n 's/^dtb //p' <<<"$listing")

products=() dtbs=()
declare -A seen_product=() seen_dtb=()
line=0
while IFS=, read -r product dtb _note || [ -n "$product" ]; do
	line=$((line + 1))
	[ $line -eq 1 ] && continue
	[ -z "$product$dtb" ] && continue
	case $product in '#'*) continue ;; esac
	if [ -z "$product" ] || [[ $dtb != *.dtb ]] || [[ $product$dtb == *[\"\'\ ]* ]]; then
		echo "$map:$line: need product_name,dtb[,note]" >&2; exit 1
	fi
	[ -n "${seen_product[$product]:-}" ] && { echo "$map:$line: $product listed twice" >&2; exit 1; }
	seen_product[$product]=1
	if ! grep -qxF "$dtb" <<<"$built"; then
		echo "warning: $dtb ($product) was not built in $obj; leaving it out" >&2
		continue
	fi
	products+=("$product") dtbs+=("$dtb")
	seen_dtb[$dtb]=1
done <"$map"

for dtb in $built; do
	[ -n "${seen_dtb[$dtb]:-}" ] || echo "warning: $dtb is built but not in $map; add a row to include it" >&2
done
[ ${#products[@]} -gt 0 ] || { echo "no board in $map has a DTB in $obj" >&2; exit 1; }

# One fdt node per distinct DTB, one configuration per board.
its=$(
	printf '/dts-v1/;\n\n/ {\n'
	printf '\tdescription = "Linux %s for SpacemiT K3 boards";\n' "$release"
	printf '\t#address-cells = <2>;\n\n\timages {\n'
	printf '\t\tkernel {\n\t\t\tdescription = "Linux %s";\n' "$release"
	printf '\t\t\tdata = /incbin/("./Image");\n\t\t\ttype = "kernel";\n\t\t\tarch = "riscv";\n\t\t\tos = "linux";\n'
	printf '\t\t\tcompression = "none";\n\t\t\tload = <0x1 0x02000000>;\n\t\t\tentry = <0x1 0x02000000>;\n'
	printf '\t\t\thash { algo = "sha256"; };\n\t\t};\n'
	declare -A node=()
	n=0
	for dtb in "${dtbs[@]}"; do
		[ -n "${node[$dtb]:-}" ] && continue
		n=$((n + 1)); node[$dtb]=fdt_$n
		printf '\n\t\tfdt_%d {\n\t\t\tdescription = "%s";\n' $n "$dtb"
		printf '\t\t\tdata = /incbin/("./%s");\n\t\t\ttype = "flat_dt";\n\t\t\tarch = "riscv";\n' "$dtb"
		printf '\t\t\tcompression = "none";\n\t\t\tload = <0x1 0x28000000>;\n'
		printf '\t\t\thash { algo = "sha256"; };\n\t\t};\n'
	done
	printf '\t};\n\n\tconfigurations {\n\t\tdefault = "conf_1";\n'
	for i in "${!products[@]}"; do
		printf '\n\t\tconf_%d {\n\t\t\tdescription = "%s";\n' $((i + 1)) "${products[$i]}"
		printf '\t\t\tkernel = "kernel";\n\t\t\tfdt = "%s";\n\t\t};\n' "${node[${dtbs[$i]}]}"
	done
	printf '\t};\n};\n'
)

# The SDK's own mkimage (2022.10), not the older one on the build host's PATH.
on_host '
set -eu
obj=$1 out=$2 its=$3; shift 3
tools=$HOME/k3-sdk/uboot-2022.10/tools
mkdir -p "$out"
cp "$obj/arch/riscv/boot/Image" "$out/"
for dtb in "$@"; do cp "$obj/arch/riscv/boot/dts/spacemit/$dtb" "$out/"; done
printf %s "$its" | base64 -d >"$out/Image.its"
cd "$out"
"$tools/mkimage" -f Image.its -r Image.itb >/dev/null
"$tools/dumpimage" -l Image.itb
echo
echo "sha256 in $out:"
sha256sum Image Image.its Image.itb "$@"
' "$obj" "$out" "$(base64 -w0 <<<"$its")" "${!seen_dtb[@]}"
