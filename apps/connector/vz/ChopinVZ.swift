// chopin-vz: runs one chopin launch in a microVM of Apple's Virtualization framework, on a Mac.
//
// It takes the words `nvx sandbox run` takes, as `nvxArguments` in apps/connector/src/nvx.ts writes
// them, so the connector starts it as it starts `nvx`, and behaves as `nvx` does for the connector:
// the workload's stdin, stdout and stderr are its own, it exits with the workload's status, and it
// ends the VM when it is stopped. The guest is an arm64 Linux (guest/Image, guest/initramfs.cpio.gz
// beside this binary's folder) with no network card: it reaches the host only over vsock, where this
// helper connects each of its connections to the connector's allow-list proxy on host loopback and
// nowhere else. See docs/vz-sandbox.md and guest/init.c.
import Darwin
import Foundation
import Virtualization

let portControl: UInt32 = 1000
let portStdin: UInt32 = 1001
let portStdout: UInt32 = 1002
let portStderr: UInt32 = 1003
let portProxy: UInt32 = 1004

func complain(_ text: String) {
	FileHandle.standardError.write(("chopin-vz: " + text + "\n").data(using: .utf8)!)
}

func quit(_ text: String, code: Int32 = 1) -> Never {
	complain(text)
	exit(code)
}

struct Mount {
	var guest: String
	var host: String
	var readOnly: Bool
	var denied: [String] = []
}

struct Options {
	var layer = ""
	var upper = "ram"
	var scratch: String?
	var ramUpperPercent = 50
	var memoryMib: UInt64 = 2048
	var hostname = "chopin"
	var user = ""
	var mounts: [Mount] = []
	var proxyPort = 0
	var environmentFile = ""
	var cwd = "/"
	var entrypoint = "/bin/sh"
	var arguments: [String] = []
}

func parse(_ words: [String]) -> Options {
	guard words.count >= 2, words[0] == "sandbox", words[1] == "run" else {
		quit("usage: chopin-vz sandbox run --layer=… [options]")
	}
	var options = Options()
	for word in words.dropFirst(2) {
		guard word.hasPrefix("--"), let equals = word.firstIndex(of: "=") else {
			quit("unexpected word \(word)")
		}
		let name = String(word[word.index(word.startIndex, offsetBy: 2)..<equals])
		let value = String(word[word.index(after: equals)...])
		switch name {
		case "hypervisor":
			if value != "vz" { quit("this helper runs Apple Virtualization (vz), not \(value)") }
		case "layer":
			// distro,<path>,<uuid>: the path may hold commas, the kind and UUID don't.
			let parts = value.split(separator: ",", omittingEmptySubsequences: false)
			guard parts.count >= 3 else { quit("bad --layer") }
			options.layer = parts[1..<(parts.count - 1)].joined(separator: ",")
		case "upper": options.upper = value
		case "scratch": options.scratch = value
		case "ram-upper-percent": options.ramUpperPercent = Int(value) ?? 50
		case "memory-mib": options.memoryMib = UInt64(value) ?? 2048
		case "hostname": options.hostname = value
		case "workload-user": options.user = value
		case "mount":
			// <guest>,<host>,<ro|rw>: a guest path never holds a comma (`checkGuestPath`), a host
			// path may.
			guard let first = value.firstIndex(of: ","), let last = value.lastIndex(of: ","),
				first != last
			else { quit("bad --mount \(value)") }
			let mode = String(value[value.index(after: last)...])
			options.mounts.append(Mount(
				guest: String(value[..<first]),
				host: String(value[value.index(after: first)..<last]),
				readOnly: mode != "rw"))
		case "mount-deny":
			guard !options.mounts.isEmpty else { quit("--mount-deny before any --mount") }
			options.mounts[options.mounts.count - 1].denied.append(value)
		case "mount-write":
			quit("--mount-write isn't supported by Apple Virtualization microVMs")
		case "network-proxy":
			guard let colon = value.lastIndex(of: ":"),
				let port = Int(value[value.index(after: colon)...])
			else { quit("bad --network-proxy") }
			options.proxyPort = port
		case "network-egress", "host-loopback":
			// Always denied here: the guest has no network card, only the relay to the proxy.
			if value != "deny" { quit("--\(name)=\(value) isn't supported") }
		case "net", "network-profile", "timeout", "exec-timeout-ms":
			break
		case "environment-file": options.environmentFile = value
		case "cwd": options.cwd = value
		case "entrypoint": options.entrypoint = value
		case "arg": options.arguments.append(value)
		default:
			quit("unknown option --\(name)")
		}
	}
	if options.layer.isEmpty { quit("no --layer") }
	if options.upper == "scratch" && options.scratch == nil { quit("--upper=scratch without --scratch") }
	return options
}

/// Writes all of `data` to `fd`; false once the other end has gone.
@discardableResult
func writeAll(_ fd: Int32, _ data: UnsafeRawBufferPointer) -> Bool {
	var sent = 0
	while sent < data.count {
		let wrote = Darwin.write(fd, data.baseAddress! + sent, data.count - sent)
		if wrote < 0 && errno == EINTR { continue }
		if wrote <= 0 { return false }
		sent += wrote
	}
	return true
}

/// Copies from `from` to `to` until `from` ends; then half-closes `to` where it is a socket.
func pump(_ from: Int32, _ to: Int32, shutdownTo: Bool) {
	var buffer = [UInt8](repeating: 0, count: 65536)
	while true {
		let got = buffer.withUnsafeMutableBytes { Darwin.read(from, $0.baseAddress!, $0.count) }
		if got < 0 && errno == EINTR { continue }
		if got <= 0 { break }
		let ok = buffer.withUnsafeBytes { writeAll(to, UnsafeRawBufferPointer(rebasing: $0[0..<got])) }
		if !ok { break }
	}
	if shutdownTo { Darwin.shutdown(to, SHUT_WR) }
}

func thread(_ body: @escaping () -> Void) {
	let worker = Thread(block: body)
	worker.stackSize = 1 << 20
	worker.start()
}

/// The connector's proxy on host loopback: the one place a guest's connections go.
func connectProxy(_ port: Int) -> Int32? {
	let fd = socket(AF_INET, SOCK_STREAM, 0)
	if fd < 0 { return nil }
	var address = sockaddr_in()
	address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
	address.sin_family = sa_family_t(AF_INET)
	address.sin_port = in_port_t(UInt16(port).bigEndian)
	address.sin_addr.s_addr = inet_addr("127.0.0.1")
	let connected = withUnsafePointer(to: &address) {
		$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
			Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
		}
	}
	if connected != 0 {
		close(fd)
		return nil
	}
	return fd
}

let options = parse(Array(CommandLine.arguments.dropFirst()))
signal(SIGPIPE, SIG_IGN)

// The guest's kernel and initramfs: in the package's guest folder, beside bin/.
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let package = executable.deletingLastPathComponent().deletingLastPathComponent()
let guestFolder = package.appendingPathComponent("guest")
let kernelURL = guestFolder.appendingPathComponent("Image")
let initrdURL = guestFolder.appendingPathComponent("initramfs.cpio.gz")

// What the guest is told: as `nvx` reads it, the environment from its private file.
var environment: [String] = []
if !options.environmentFile.isEmpty {
	guard let data = FileManager.default.contents(atPath: options.environmentFile),
		let list = try? JSONSerialization.jsonObject(with: data) as? [String]
	else { quit("couldn't read the environment file") }
	environment = list
}

// A helper ended by force, as the connector ends a launch it stops, leaves its folder: the next one
// removes those whose process is gone.
if let names = try? FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory()) {
	for name in names where name.hasPrefix("chopin-vz-") {
		let parts = name.split(separator: "-")
		guard parts.count >= 4, let pid = Int32(parts[2]), pid > 1 else { continue }
		if kill(pid, 0) != 0 && errno == ESRCH {
			try? FileManager.default.removeItem(atPath: NSTemporaryDirectory() + "/" + name)
		}
	}
}

// A private folder for the console's log and the single files shared with the guest.
let scratchFolder = URL(fileURLWithPath: NSTemporaryDirectory())
	.appendingPathComponent("chopin-vz-\(getpid())-\(UUID().uuidString.prefix(8))")
try? FileManager.default.createDirectory(
	at: scratchFolder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let consoleLog = scratchFolder.appendingPathComponent("console.log")
FileManager.default.createFile(atPath: consoleLog.path, contents: nil)

func cleanUp() {
	try? FileManager.default.removeItem(at: scratchFolder)
}

func consoleTail() -> String {
	guard let text = try? String(contentsOf: consoleLog, encoding: .utf8) else { return "" }
	let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
		.filter { !$0.isEmpty }
	return lines.suffix(8).joined(separator: " / ")
}

// The configuration the guest's init reads first on the control port: NUL-terminated words.
var words: [String] = []
var now = timespec()
clock_gettime(CLOCK_REALTIME, &now)
words += ["time", String(now.tv_sec), String(now.tv_nsec)]
words += ["hostname", options.hostname, "user", options.user, "cwd", options.cwd]
words += ["upper", options.scratch != nil ? "disk" : "ram", String(options.ramUpperPercent)]
if options.proxyPort > 0 { words += ["proxy", String(options.proxyPort)] }

let configuration = VZVirtualMachineConfiguration()
let bootLoader = VZLinuxBootLoader(kernelURL: kernelURL)
bootLoader.initialRamdiskURL = initrdURL
bootLoader.commandLine = "console=hvc0 quiet loglevel=3 panic=-1 rdinit=/init"
configuration.bootLoader = bootLoader
configuration.cpuCount = max(
	VZVirtualMachineConfiguration.minimumAllowedCPUCount,
	min(2, ProcessInfo.processInfo.processorCount))
configuration.memorySize = max(
	VZVirtualMachineConfiguration.minimumAllowedMemorySize, options.memoryMib * 1024 * 1024)

var storage: [VZStorageDeviceConfiguration] = []
do {
	let layer = try VZDiskImageStorageDeviceAttachment(
		url: URL(fileURLWithPath: options.layer), readOnly: true)
	storage.append(VZVirtioBlockDeviceConfiguration(attachment: layer))
	if let scratch = options.scratch {
		let disk = try VZDiskImageStorageDeviceAttachment(
			url: URL(fileURLWithPath: scratch), readOnly: false)
		storage.append(VZVirtioBlockDeviceConfiguration(attachment: disk))
	}
} catch {
	quit("couldn't attach the image's layer or disk: \(error.localizedDescription)")
}
configuration.storageDevices = storage

var shares: [VZDirectorySharingDeviceConfiguration] = []
for (index, mount) in options.mounts.enumerated() {
	let tag = "s\(index)"
	var isFolder: ObjCBool = false
	guard FileManager.default.fileExists(atPath: mount.host, isDirectory: &isFolder) else {
		quit("\(mount.host) isn't there to share")
	}
	var folder = URL(fileURLWithPath: mount.host)
	var file = ""
	if !isFolder.boolValue {
		// virtio-fs shares folders: a single file goes in a folder of its own, copied, so the guest
		// sees nothing beside it.
		let own = scratchFolder.appendingPathComponent(tag)
		try? FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
		file = folder.lastPathComponent
		do {
			try FileManager.default.copyItem(at: folder, to: own.appendingPathComponent(file))
		} catch {
			quit("couldn't share \(mount.host): \(error.localizedDescription)")
		}
		folder = own
	}
	let device = VZVirtioFileSystemDeviceConfiguration(tag: tag)
	device.share = VZSingleDirectoryShare(
		directory: VZSharedDirectory(url: folder, readOnly: mount.readOnly || !file.isEmpty))
	shares.append(device)
	words += ["share", tag, mount.guest, mount.readOnly ? "ro" : "rw", file]
	for denied in mount.denied {
		let inside = denied.split(separator: "/").joined(separator: "/")
		words += ["deny", (mount.guest as NSString).appendingPathComponent(inside)]
	}
}
configuration.directorySharingDevices = shares

let console = VZVirtioConsoleDeviceSerialPortConfiguration()
guard let logHandle = FileHandle(forWritingAtPath: consoleLog.path) else {
	quit("couldn't open the console's log")
}
console.attachment = VZFileHandleSerialPortAttachment(
	fileHandleForReading: nil, fileHandleForWriting: logHandle)
configuration.serialPorts = [console]
configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]

for variable in environment { words += ["env", variable] }
for word in [options.entrypoint] + options.arguments { words += ["arg", word] }
words.append("end")
var payload = Data()
for word in words {
	if word.utf8.contains(0) { quit("a configuration word holds a NUL") }
	payload.append(word.data(using: .utf8)!)
	payload.append(0)
}
var configurationBytes = Data("\(payload.count)\n".utf8)
configurationBytes.append(payload)

do {
	try configuration.validate()
} catch {
	quit("the microVM's configuration isn't valid: \(error.localizedDescription)")
}

/// The VM, its connections and how it ends. Everything here runs on the main queue.
final class Machine: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
	let vm: VZVirtualMachine
	var connections: [VZVirtioSocketConnection] = []
	var control: Int32 = -1
	var exitCode: Int32?
	var streamsOpen = 2
	var finishing = false
	var stopping = false
	/// The ports the guest's init has connected to, each of which it connects to once.
	var taken = Set<UInt32>()
	let listener = VZVirtioSocketListener()

	init(_ configuration: VZVirtualMachineConfiguration) {
		vm = VZVirtualMachine(configuration: configuration)
		super.init()
		vm.delegate = self
		listener.delegate = self
		let device = vm.socketDevices.first as! VZVirtioSocketDevice
		for port in [portControl, portStdin, portStdout, portStderr, portProxy] {
			device.setSocketListener(listener, forPort: port)
		}
	}

	func listener(
		_ listener: VZVirtioSocketListener,
		shouldAcceptNewConnection connection: VZVirtioSocketConnection,
		from socketDevice: VZVirtioSocketDevice
	) -> Bool {
		let port = connection.destinationPort
		// The init opens the control port and each stream once, before the workload starts. Anything
		// later on those ports is the workload's own, which may reach the proxy and nothing else: it
		// never gets a second copy of the launch's stdin, nor a say in when its streams have ended.
		if port != portProxy && !taken.insert(port).inserted { return false }
		connections.append(connection)
		let fd = connection.fileDescriptor
		switch port {
		case portControl:
			control = fd
			thread { self.serveControl(fd) }
			keepTime()
		case portStdin:
			thread { pump(STDIN_FILENO, fd, shutdownTo: true) }
		case portStdout:
			thread {
				pump(fd, STDOUT_FILENO, shutdownTo: false)
				DispatchQueue.main.async { self.streamEnded() }
			}
		case portStderr:
			thread {
				pump(fd, STDERR_FILENO, shutdownTo: false)
				DispatchQueue.main.async { self.streamEnded() }
			}
		case portProxy:
			let proxyPort = options.proxyPort
			thread {
				// Closed once both ways have ended, so a guest that lives for days keeps none open.
				defer {
					DispatchQueue.main.async {
						connection.close()
						self.connections.removeAll { $0 === connection }
					}
				}
				guard proxyPort > 0, let proxy = connectProxy(proxyPort) else {
					Darwin.shutdown(fd, SHUT_RDWR)
					return
				}
				let back = DispatchSemaphore(value: 0)
				thread {
					pump(proxy, fd, shutdownTo: true)
					back.signal()
				}
				pump(fd, proxy, shutdownTo: true)
				back.wait()
				close(proxy)
			}
		default:
			return false
		}
		return true
	}

	func serveControl(_ fd: Int32) {
		configurationBytes.withUnsafeBytes { _ = writeAll(fd, $0) }
		var line = Data()
		var buffer = [UInt8](repeating: 0, count: 1024)
		while true {
			let got = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
			if got < 0 && errno == EINTR { continue }
			if got <= 0 { return }
			line.append(contentsOf: buffer[0..<got])
			while let end = line.firstIndex(of: 10) {
				let text = String(decoding: line[line.startIndex..<end], as: UTF8.self)
				line.removeSubrange(line.startIndex...end)
				DispatchQueue.main.async { self.heard(text) }
			}
		}
	}

	/// The guest has no clock of its own to follow: it is told the host's again every minute.
	func keepTime() {
		DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
			if self.finishing || self.control < 0 { return }
			var now = timespec()
			clock_gettime(CLOCK_REALTIME, &now)
			let line = "time \(now.tv_sec) \(now.tv_nsec)\n"
			_ = line.withCString { Darwin.write(self.control, $0, strlen($0)) }
			self.keepTime()
		}
	}

	func heard(_ text: String) {
		if text.hasPrefix("exit ") {
			exitCode = Int32(text.dropFirst(5)) ?? 1
			// The guest has nothing more to say once both streams end; give them a moment.
			if streamsOpen == 0 { finish() }
			DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.finish() }
		} else if text.hasPrefix("fail ") {
			complain("the microVM couldn't start its workload: \(text.dropFirst(5))")
			exitCode = 1
			finish()
		}
	}

	func streamEnded() {
		streamsOpen -= 1
		if streamsOpen == 0 && exitCode != nil { finish() }
	}

	func finish() {
		if finishing { return }
		finishing = true
		let code = exitCode ?? 1
		if vm.state == .running || vm.state == .paused {
			vm.stop { _ in
				cleanUp()
				exit(code)
			}
		} else {
			cleanUp()
			exit(code)
		}
	}

	/// A stop from the connector: the workload is told first, then the VM ends whatever it does.
	func terminate(_ signal: Int32) {
		if stopping { return }
		stopping = true
		if control >= 0 { _ = "term\n".withCString { Darwin.write(control, $0, 5) } }
		DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
			if self.exitCode == nil { self.exitCode = 128 + signal }
			self.finish()
		}
	}

	func guestDidStop(_ virtualMachine: VZVirtualMachine) {
		if exitCode == nil {
			let tail = consoleTail()
			complain("the microVM stopped before its workload ended\(tail.isEmpty ? "" : ": \(tail)")")
		}
		finishing = false
		finish()
	}

	func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
		let tail = consoleTail()
		complain(
			"the microVM stopped: \(error.localizedDescription)\(tail.isEmpty ? "" : " (\(tail))")")
		if exitCode == nil { exitCode = 1 }
		finishing = false
		finish()
	}
}

let machine = Machine(configuration)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
	signal(sig, SIG_IGN)
	let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
	source.setEventHandler { machine.terminate(sig) }
	source.resume()
	signalSources.append(source)
}
machine.vm.start { result in
	if case .failure(let error) = result {
		let tail = consoleTail()
		cleanUp()
		quit("the microVM didn't start: \(error.localizedDescription)\(tail.isEmpty ? "" : " (\(tail))")")
	}
}
dispatchMain()
