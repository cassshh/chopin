# Agents in Apple Virtualization microVMs (Mac)

On a Mac with Apple silicon, chopin runs every agent in a microVM of Apple's
Virtualization framework instead of NVX, which has no macOS backend and boots
x86_64 guests only. It is the same model as [NVX microVMs](nvx-sandbox.md): one
microVM per launch, booted from an image's EROFS layer, shown only its shares,
with the connector's allow-list proxy as its only way out. Everything above the
seam (runs, Planners, spares, images, disks, the proxy, the AI relay, Chopin's
checks) is unchanged. This is an experimental engine.

## How it fits the seam

`Sandbox.spawn` still turns a launch into a `VmSpec` with `vmSpec` and that into
`nvx sandbox run`'s words with `nvxArguments`. On a Mac the program those words
are given to is `chopin-vz` (`apps/connector/vz/ChopinVZ.swift`), which takes the
same words and boots the microVM with Virtualization.framework. So `startVm`,
`makeDisk`, the image builds and the start checks run through the same code on
every host. What differs is chosen by the hypervisor, `vz`:

| Part              | NVX (Linux, Windows)                     | Apple Virtualization (Mac)                              |
| ----------------- | ---------------------------------------- | ------------------------------------------------------- |
| Support check     | `/dev/kvm`, `/dev/mshv` or WHP on x86_64 | macOS on arm64, not as root (`nvxSupport`)              |
| Program           | `nvx`                                    | `chopin-vz`, with `--hypervisor=vz`                     |
| Guest             | x86_64, NVX's kernel and Ubuntu layer    | arm64, Ubuntu's kernel and a base layer of its own      |
| Image recipe      | x86_64 Node, `GUEST_PACKAGES`            | arm64 Node, `ARM64_GUEST_PACKAGES` (`images.ts` `arch`) |
| What Chopin hears | `{ engine: "nvx", hypervisor }`          | `{ engine: "vz", hypervisor: "vz" }`                    |
| Package           | Downloaded, pinned (`NVX_RELEASE`)       | Downloaded, pinned (`VZ_RELEASE`)                       |

Chopin takes either report as a connector that runs its agents in microVMs
(`runsMicrovms` in `packages/protocol/connector.ts`); the Machines page says
"Each agent in its own microVM (Apple Virtualization)".

## The guest

The package (`build.sh`, which needs Xcode's command line tools and Docker) holds:

- `bin/chopin-vz`, signed ad hoc with the `com.apple.security.virtualization`
  entitlement, which Virtualization.framework requires;
- `guest/Image`, Ubuntu 26.04's arm64 kernel, unpacked from its EFI zboot image;
- `guest/initramfs.cpio.gz`, a static init (`vz/guest/init.c`) and the modules it
  loads (virtio-rng, vsock, virtio-fs, EROFS, overlay);
- `guest/ubuntu-distro.erofs` and its manifest, the base layer every image is
  made from (Ubuntu 26.04 by digest, with e2fsprogs for `makeDisk`);
- `guest/guest-packages.json`, the arm64 packages an image's build unpacks,
  which `apps/connector/src/guest-packages-arm64.ts` pins.

A microVM gets the image's layer as a read-only disk, an overlay upper in its
memory (`--ram-upper-percent` of it) or on its scratch disk (a Planner's), each
share as virtio-fs at its host path, 2 vCPUs and the memory the spec asks. The
init mounts all of it, moves into the new root and runs the workload as the
image's user with the launch's environment, its stdin, stdout and stderr as
pipes. It powers the VM off once the workload ends, after killing whatever the
workload left, and `chopin-vz` exits with the workload's status. A stop
(`SIGTERM`) tells the workload first and ends the VM five seconds later.

## Network

The guest has no network card. Its only connection is vsock to the host:

- the launch's configuration, the workload's streams and its exit status;
- one vsock connection per TCP connection to `10.0.0.1:<proxy port>`, which the
  init's relay listens on inside the guest and `chopin-vz` connects to the
  connector's proxy on host loopback, and nothing else.

`chopin-vz` takes the control port and each stream once, from the init, before the
workload starts: a workload that connects to them itself is refused, so it gets no
second copy of the launch's stdin and no say in when its streams end. The proxy's
port is the only one it can open.

So the guest can reach the proxy and nothing else: no other port of the host, no
other host on its loopback or network, no DNS, no UDP, no IPv6. The proxy then
decides as it does for NVX.

## Differences from NVX, said plainly

- **Hidden paths** (`--sandbox-hide`, `--mount-deny`) are hidden by the guest's
  init, which mounts an empty, unreadable file system over each before the
  workload starts. The host still shares the folder that holds them. A workload
  runs as an unprivileged user and can't unmount them, but one that became root in
  its guest could. Read-only shares are read-only on the host's side too.
- **A single shared file** (the MCP bridge) is copied into a folder of its own
  when the microVM starts, since virtio-fs shares folders: a change to the host's
  file after that isn't seen.
- **`--mount-write`** isn't supported; `vmSpec` never asks for it.
- NVX's start retry (OpenVMM's io_uring failure), its run folders and its
  device-denied detection have nothing to do on a Mac.

## Other differences on a Mac

- **The clock.** A guest has no clock of its own to follow, so `chopin-vz` sets it as
  the guest boots and again every minute.
- **Spare Planners and memory.** A spare starts only while the machine has memory for
  it. `freemem()` counts only a Mac's unused pages, a few hundred MB on one with most of
  its memory to give, so there the connector reads `vm_stat` and counts what macOS would
  take back first too (`macAvailable` in `planner-spare.ts`).
- **Temporary folders.** A Mac's `$TMPDIR` is named through a link (`/var` to
  `/private/var`), and a guest has paths only where they really are, as `vmSpec`
  already maps them. A helper ended by force leaves its small log folder there; the next
  one removes it.

## Tests

- `apps/connector/src/nvx-vm.test.ts`, the real-microVM tests, run on a Mac where
  `CHOPIN_VZ_ROOT` names a built package, as they run on Linux with `CHOPIN_NVX_ROOT`:
  what a guest can reach, write and keep, a Planner command, and spare Planners. The
  three that make OpenVMM fail with `strace` are skipped.
- `e2e/connector-vz.e2e.ts` pairs a connector in the browser suite's Chopin, builds a
  fake agent's image and runs an investigation whose agent publishes through its run's
  MCP bridge, all in real microVMs. It is skipped without `CHOPIN_VZ_ROOT`:

  ```sh
  CHOPIN_VZ_ROOT=~/chopin-vz bun test apps/connector/src/nvx-vm.test.ts
  CHOPIN_VZ_ROOT=~/chopin-vz bun run e2e connector-vz.e2e.ts
  ```

## Shipping the package

A `chopin` pins one package (`VZ_RELEASE` in `nvx.ts`): its version, its release's tag,
its archive's name and SHA-256, as it pins NVX's. The first time a Mac needs it,
`chopin` downloads the archive (about 60 MB, 130 MB unpacked) from that release's
asset on GitHub, checks the pin and each file against the package's own
`SHA256SUMS`, unpacks it into `<state>/vz/<version>/` and removes versions it no
longer pins. Nothing else is asked of the Mac: no checkout, Docker or Xcode.

Releasing one is done by hand, on a Mac on Apple silicon with Docker and Xcode's
command line tools:

1. Set the new `version`, `tag` and `file` in `VZ_RELEASE`.
2. `apps/connector/vz/build.sh --archive <folder>` writes the archive and prints its
   SHA-256; put that in `VZ_RELEASE.sha256`. It also writes `guest-packages.json`, the
   arm64 packages `guest-packages-arm64.ts` pins, which change with the base layer.
3. Publish the archive as that tag's release asset. A published archive is never
   replaced: a rebuild makes a new base layer, so another SHA-256, and is a new version.

`build.sh` with no argument installs a package built from the checkout where the
connector looks instead, and `build.sh <folder>` builds one for `CHOPIN_VZ_ROOT` to
name: both are for work on the package itself. The helper is signed ad hoc with its
entitlement; whether that signature is enough on a Mac other than the one that built
it has not been tried yet.

## Trying it

From a checkout of this branch (the released `chopin` binaries don't carry it yet):

```sh
bun apps/connector/src/main.ts connect --agent atomic
```

Measured on an M2 Pro: a microVM starts and runs a command in under a second; the
Atomic agent's image builds in about 50 seconds, once; a new document's Planner
attaches about 1.6 seconds after it is asked for cold, and in 30 to 80 ms on a spare.
