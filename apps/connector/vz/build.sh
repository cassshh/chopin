#!/bin/sh
# Builds chopin's Apple Virtualization package for a Mac on Apple silicon: bin/chopin-vz, the helper
# that starts each microVM, and guest/, the arm64 kernel, initramfs and Ubuntu base layer its guests
# boot.
#
#   build.sh                    installs the package where the connector looks for it, in its state
#                               directory (<state>/vz/<version>), for work on the package itself
#   build.sh <folder>           builds it there instead, for CHOPIN_VZ_ROOT to name
#   build.sh --archive [folder] writes it as the one archive a release publishes (VZ_RELEASE.file in
#                               src/nvx.ts) into the folder, the current one by default, and prints
#                               its SHA-256, which VZ_RELEASE pins
#
# Needs Xcode's command line tools (swiftc, codesign) and Docker (for the guest half, built in an
# arm64 Ubuntu container).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# The package's version and archive name, as the connector pins them (VZ_RELEASE in src/nvx.ts).
pinned() {
	sed -n '/^export const VZ_RELEASE = {$/,/^} as const;$/p' "$here/../src/nvx.ts" |
		sed -n "s/^	$1: \"\([^\"]*\)\",\$/\1/p"
}
version=$(pinned version)
file=$(pinned file)
[ -n "$version" ] && [ -n "$file" ] || {
	echo "build.sh couldn't read the package's version from src/nvx.ts." >&2
	exit 1
}
archive=
if [ "${1:-}" = --archive ]; then
	archive=$(mkdir -p "${2:-.}" && cd "${2:-.}" && pwd)
	target=$(mktemp -d)
else
	# The connector's state directory, as `stateDirectory` in src/workspace.ts finds it.
	state="${CHOPIN_HOME:-${CHOPIN_CONNECTOR_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/chopin/connector}}"
	target="${1:-$state/vz/$version}"
fi
out=$(mkdir -p "$target" && cd "$target" && pwd)
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
if [ -n "$archive" ]; then
	# The generated pins are for src/guest-packages-arm64.ts, not for a guest.
	cp "$out/guest/guest-packages.json" "$archive/guest-packages.json"
	tar -czf "$archive/$file" -C "$out" bin guest SHA256SUMS
	rm -rf "$out"
	echo "✓ Wrote $archive/$file"
	echo "  SHA-256 (for VZ_RELEASE.sha256): $(shasum -a 256 "$archive/$file" | cut -d' ' -f1)"
elif [ -n "${1:-}" ]; then
	echo "✓ Built into $out. Use it with: CHOPIN_VZ_ROOT=$out chopin connect"
else
	# What tells the connector the package in its state directory is whole.
	echo "$version" > "$out/.verified"
	echo "✓ Installed chopin's Apple Virtualization package $version in $out. chopin connect finds it there."
fi
