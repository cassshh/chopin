# The base layer of chopin's arm64 guests on a Mac: Ubuntu 26.04 with what `makeDisk` (mkfs.ext4)
# and an image's build (dpkg-deb, tar, gzip) use. Pinned by digest, so a rebuild makes the same tree.
FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db
RUN apt-get update -qq \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends e2fsprogs \
	&& rm -rf /var/lib/apt/lists/*
