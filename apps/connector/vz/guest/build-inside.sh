#!/bin/sh
# Runs in an arm64 Ubuntu 26.04 container (see ../build.sh): makes the guest half of chopin's Apple
# Virtualization package in /out/guest from the inputs in /in.
#
#   /in/init.c      the guest's first process
#   /in/base.tar    the base layer's root file system (`docker export` of ../base.Dockerfile)
#
# It writes the kernel (an uncompressed arm64 Image), an initramfs holding the init and the modules
# it loads, the base layer as EROFS with its manifest, and the arm64 Ubuntu packages an image's build
# needs beyond that layer, pinned by path and SHA-256 (guest-packages.json).
set -eu
KERNEL="${KERNEL:?}"
OUT=/out/guest
mkdir -p "$OUT"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends gcc libc6-dev zstd cpio kmod erofs-utils python3-minimal \
	uuid-runtime ca-certificates >/dev/null

work=$(mktemp -d)
cd "$work"

# The init, static, so the initramfs needs nothing else.
gcc -static -O2 -Wall -Wextra -Wno-unused-parameter -o init /in/init.c

# The kernel and its modules, as Ubuntu ships them for arm64.
apt-get download -qq "linux-image-$KERNEL" "linux-modules-$KERNEL"
mkdir kernel
for deb in linux-*.deb; do dpkg-deb -x "$deb" kernel; done
modules="kernel/usr/lib/modules/$KERNEL"
[ -d "$modules" ] || modules="kernel/lib/modules/$KERNEL"
mkdir -p kernel/lib/modules
[ -e "kernel/lib/modules/$KERNEL" ] || ln -s "$(realpath "$modules")" "kernel/lib/modules/$KERNEL"
depmod -b kernel "$KERNEL"

# Ubuntu's arm64 vmlinuz is a signed EFI application around an EFI zboot image, whose payload is the
# compressed Image. Virtualization.framework boots an uncompressed Image.
python3 - "kernel/boot/vmlinuz-$KERNEL" "$OUT/Image" <<'PY'
import struct, subprocess, sys
data = open(sys.argv[1], "rb").read()
at = data.find(b"zimg")
if at < 4 or data[at - 4:at - 2] != b"MZ":
	sys.exit("no EFI zboot image in the kernel")
start = at - 4
offset, size = struct.unpack_from("<II", data, start + 8)
kind = data[start + 24:start + 56].split(b"\0")[0].decode()
payload = data[start + offset:start + offset + size]
tool = {"gzip": ["gzip", "-dc"], "zstd": ["zstd", "-dc"], "zstd22": ["zstd", "-dc"]}.get(kind)
if not tool:
	sys.exit(f"the kernel is compressed with {kind}, which this script doesn't unpack")
image = subprocess.run(tool, input=payload, stdout=subprocess.PIPE, check=True).stdout
if image[56:60] != b"ARM\x64":
	sys.exit("the unpacked kernel isn't an arm64 Image")
open(sys.argv[2], "wb").write(image)
PY

# The modules the init loads, in the order modprobe would, uncompressed.
mkdir -p initramfs/modules initramfs/dev initramfs/proc initramfs/sys
: > initramfs/modules.order
for module in virtio-rng vmw_vsock_virtio_transport virtiofs erofs overlay; do
	modprobe -d kernel -S "$KERNEL" --show-depends "$module" | while read -r kind path _; do
		[ "$kind" = insmod ] || continue
		name=$(basename "$path" .zst)
		grep -qx "$name" initramfs/modules.order && continue
		case "$path" in
		*.zst) zstd -qdc "$path" > "initramfs/modules/$name" ;;
		*) cp "$path" "initramfs/modules/$name" ;;
		esac
		echo "$name" >> initramfs/modules.order
	done
done
cp init initramfs/init
(cd initramfs && find . | sort | cpio -o -H newc --quiet --owner 0:0) | gzip -9 > "$OUT/initramfs.cpio.gz"

# The base layer every image is made from, with a fixed UUID per build.
mkdir root
tar -xf /in/base.tar -C root
rm -f root/.dockerenv
uuid=$(uuidgen)
mkfs.erofs -zlz4hc -U "$uuid" "$OUT/ubuntu-distro.erofs" root
# A disk image attachment wants whole sectors.
size=$(stat -c %s "$OUT/ubuntu-distro.erofs")
truncate -s $(( (size + 4095) / 4096 * 4096 )) "$OUT/ubuntu-distro.erofs"
printf '{"uuid":"%s","kernel":"%s"}\n' "$uuid" "$KERNEL" > "$OUT/ubuntu-distro.erofs.manifest.json"

# What an image's build needs beyond the base layer: git and its HTTPS libraries for the agent, and
# erofs-utils for the build itself, as apt would download them onto that layer, each pinned by its
# path in the Ubuntu archive and the SHA-256 of what was downloaded.
rm -f root/etc/resolv.conf
cp /etc/resolv.conf root/etc/resolv.conf
chroot root apt-get update -qq >/dev/null
pins() {
	chroot root apt-get install --print-uris -qq --no-install-recommends "$@" |
		sed -n "s/^'\([^']*\)' \([^ ]*\) .*$/\1 \2/p" > "$work/uris"
	first=1
	while read -r uri file; do
		path=${uri#*/ubuntu/}
		chroot root sh -c "cd /tmp && apt-get download -qq '$(echo "$file" | cut -d_ -f1)=$(echo "$file" | cut -d_ -f2 | sed 's/%3a/:/')'" >/dev/null 2>&1
		sum=$(sha256sum "root/tmp/$file" | cut -d' ' -f1)
		rm -f "root/tmp/$file"
		name=$(echo "$file" | cut -d_ -f1)
		version=$(echo "$file" | cut -d_ -f2 | sed 's/%3a/:/')
		[ $first = 1 ] || printf ','
		first=0
		printf '{"name":"%s","version":"%s","path":"%s","sha256":"%s"}\n' "$name" "$version" "$path" "$sum"
	done < "$work/uris"
}
{
	echo '{"guest":['
	pins git
	echo '],"build":['
	pins erofs-utils
	echo ']}'
} > "$OUT/guest-packages.json"
ls -la "$OUT"
