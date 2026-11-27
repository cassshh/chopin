#!/bin/sh
# Builds chopin's Apple Virtualization package for a Mac on Apple silicon into $1 (default
# ./vz-package): bin/chopin-vz, the helper that starts each microVM, and guest/, the arm64 kernel,
# initramfs and Ubuntu base layer its guests boot. Point the connector at it with CHOPIN_VZ_ROOT.
#
# Needs Xcode's command line tools (swiftc, codesign) and Docker (for the guest half, built in an
# arm64 Ubuntu container).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "${1:-vz-package}" && cd "${1:-vz-package}" && pwd)
kernel="${KERNEL:-7.0.0-44-generic}"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
	echo "build.sh builds the package for macOS on Apple silicon only." >&2
	exit 1
}

mkdir -p "$out/bin" "$out/guest"
echo "… Building chopin-vz"
swiftc -O -o "$out/bin/chopin-vz" "$here/ChopinVZ.swift" -framework Virtualization
# Virtualization.framework runs only for a binary signed with this entitlement; an ad-hoc signature
# is enough on the machine that built it.
codesign --force --sign - --entitlements "$here/chopin-vz.entitlements" "$out/bin/chopin-vz"

echo "… Building the base layer's root file system"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
docker build -q --platform linux/arm64 -t chopin-vz-base -f "$here/guest/base.Dockerfile" "$here/guest" >/dev/null
container=$(docker create --platform linux/arm64 chopin-vz-base)
docker export "$container" > "$work/base.tar"
docker rm "$container" >/dev/null
cp "$here/guest/init.c" "$work/init.c"

echo "… Building the guest's kernel, initramfs and layer"
docker run --rm --platform linux/arm64 -e KERNEL="$kernel" \
	-v "$work:/in:ro" -v "$out:/out" -v "$here/guest/build-inside.sh:/build-inside.sh:ro" \
	ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db \
	sh /build-inside.sh

(cd "$out" && find bin guest -type f ! -name SHA256SUMS | sort | xargs shasum -a 256 > SHA256SUMS)
echo "✓ Built into $out. Use it with: CHOPIN_VZ_ROOT=$out chopin connect"
