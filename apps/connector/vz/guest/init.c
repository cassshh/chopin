/*
 * The first process of every Apple Virtualization microVM chopin starts on a Mac (see
 * docs/vz-sandbox.md). The host helper (`chopin-vz`) gives the guest no network card: everything
 * it hears and says goes over vsock to the host's CID, on these ports:
 *
 *   1000  control: the launch's configuration in, the workload's exit status out, `term` in
 *   1001  the workload's stdin
 *   1002  the workload's stdout
 *   1003  the workload's stderr
 *   1004  one connection to the connector's allow-list proxy, per TCP connection the guest makes
 *         to 10.0.0.1:<proxy port>
 *
 * It loads the kernel modules it needs, mounts the image's EROFS layer under an overlay whose upper
 * is in memory or on the launch's scratch disk, mounts each share (virtio-fs) where the launch
 * says, hides what the launch denies, moves into that root, and runs the workload as its user with
 * its environment. It powers the VM off once the workload has ended.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/vm_sockets.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define HOST_CID 2
#define PORT_CONTROL 1000
#define PORT_STDIN 1001
#define PORT_STDOUT 1002
#define PORT_STDERR 1003
#define PORT_PROXY 1004
#define GATEWAY "10.0.0.1"

static int control = -1;

static void say(const char *format, ...) {
	char line[1024];
	va_list args;
	va_start(args, format);
	int length = vsnprintf(line, sizeof line - 1, format, args);
	va_end(args);
	if (length < 0) return;
	if (length > (int)sizeof line - 2) length = sizeof line - 2;
	line[length++] = '\n';
	int console = open("/dev/console", O_WRONLY | O_NOCTTY);
	if (console >= 0) {
		(void)!write(console, line, length);
		close(console);
	}
}

static void power_off(void) {
	sync();
	reboot(RB_POWER_OFF);
	for (;;) pause();
}

/* A launch that can't be given what it asks: the host hears why, and the VM ends. */
static void fail(const char *format, ...) {
	char reason[900];
	va_list args;
	va_start(args, format);
	vsnprintf(reason, sizeof reason, format, args);
	va_end(args);
	say("chopin-init: %s", reason);
	if (control >= 0) {
		char line[1024];
		int length = snprintf(line, sizeof line, "fail %s\n", reason);
		(void)!write(control, line, length);
	}
	power_off();
}

static int vsock_connect(unsigned port, int tries) {
	for (int attempt = 0; attempt < tries; attempt++) {
		int fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd < 0) {
			usleep(20000);
			continue;
		}
		struct sockaddr_vm address = {.svm_family = AF_VSOCK, .svm_cid = HOST_CID, .svm_port = port};
		if (connect(fd, (struct sockaddr *)&address, sizeof address) == 0) return fd;
		close(fd);
		usleep(20000);
	}
	return -1;
}

static void load_modules(void) {
	FILE *order = fopen("/modules.order", "r");
	if (!order) return;
	char name[512];
	while (fgets(name, sizeof name, order)) {
		name[strcspn(name, "\n")] = 0;
		if (!*name) continue;
		char path[600];
		snprintf(path, sizeof path, "/modules/%s", name);
		int fd = open(path, O_RDONLY | O_CLOEXEC);
		if (fd < 0) fail("no module %s", name);
		if (syscall(SYS_finit_module, fd, "", 0) != 0 && errno != EEXIST) {
			fail("couldn't load %s: %s", name, strerror(errno));
		}
		close(fd);
	}
	fclose(order);
}

static void wait_for(const char *path) {
	for (int attempt = 0; attempt < 500; attempt++) {
		if (access(path, F_OK) == 0) return;
		usleep(10000);
	}
	fail("%s never appeared", path);
}

/* mkdir -p, with each folder made 0755. */
static void make_folders(const char *path) {
	char copy[4096];
	snprintf(copy, sizeof copy, "%s", path);
	for (char *slash = copy + 1; *slash; slash++) {
		if (*slash != '/') continue;
		*slash = 0;
		if (mkdir(copy, 0755) != 0 && errno != EEXIST) fail("couldn't make %s: %s", copy, strerror(errno));
		*slash = '/';
	}
	if (mkdir(copy, 0755) != 0 && errno != EEXIST) fail("couldn't make %s: %s", copy, strerror(errno));
}

static void must_mount(const char *source, const char *target, const char *type, unsigned long flags,
	const char *data) {
	if (mount(source, target, type, flags, data) != 0) {
		fail("couldn't mount %s on %s (%s): %s", source, target, type ? type : "bind", strerror(errno));
	}
}

/*
 * The launch's configuration, as the host sends it: its length in decimal and a newline, then that
 * many bytes of NUL-terminated words, the last of them `end`.
 */
typedef struct {
	char **words;
	size_t count;
	size_t at;
} Words;

static Words read_configuration(void) {
	char digits[24];
	size_t length = 0;
	for (;;) {
		char character;
		if (read(control, &character, 1) != 1) fail("the host ended the configuration early");
		if (character == '\n') break;
		if (character < '0' || character > '9' || length == sizeof digits - 1) fail("bad configuration");
		digits[length++] = character;
	}
	digits[length] = 0;
	size_t size = strtoull(digits, NULL, 10);
	if (!size || size > (64 << 20)) fail("bad configuration size");
	char *buffer = malloc(size);
	if (!buffer) fail("out of memory");
	for (size_t got = 0; got < size;) {
		ssize_t read_now = read(control, buffer + got, size - got);
		if (read_now <= 0) fail("the host ended the configuration early");
		got += read_now;
	}
	if (buffer[size - 1] != 0) fail("bad configuration");
	Words words = {0};
	for (size_t at = 0; at < size; at += strlen(buffer + at) + 1) words.count++;
	words.words = calloc(words.count, sizeof(char *));
	size_t index = 0;
	for (size_t at = 0; at < size; at += strlen(buffer + at) + 1) words.words[index++] = buffer + at;
	return words;
}

static const char *next(Words *words) {
	if (words->at >= words->count) fail("the configuration ended early");
	return words->words[words->at++];
}

#define MOST 1024

typedef struct {
	const char *tag;
	const char *guest;
	int read_only;
	const char *file;
} Share;

static void bring_up_loopback(void) {
	int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	if (fd < 0) fail("no socket: %s", strerror(errno));
	struct ifreq request = {0};
	strcpy(request.ifr_name, "lo");
	if (ioctl(fd, SIOCGIFFLAGS, &request) != 0) fail("no lo: %s", strerror(errno));
	request.ifr_flags |= IFF_UP | IFF_RUNNING;
	if (ioctl(fd, SIOCSIFFLAGS, &request) != 0) fail("couldn't bring lo up: %s", strerror(errno));
	/* The gateway's address, which only this guest's relay listens on. */
	struct ifreq alias = {0};
	strcpy(alias.ifr_name, "lo:0");
	struct sockaddr_in *address = (struct sockaddr_in *)&alias.ifr_addr;
	address->sin_family = AF_INET;
	inet_pton(AF_INET, GATEWAY, &address->sin_addr);
	if (ioctl(fd, SIOCSIFADDR, &alias) != 0) fail("couldn't add %s: %s", GATEWAY, strerror(errno));
	address = (struct sockaddr_in *)&alias.ifr_netmask;
	address->sin_family = AF_INET;
	inet_pton(AF_INET, "255.255.255.255", &address->sin_addr);
	ioctl(fd, SIOCSIFNETMASK, &alias);
	alias.ifr_flags = IFF_UP | IFF_RUNNING;
	ioctl(fd, SIOCSIFFLAGS, &alias);
	close(fd);
}

/* Copies both ways between `a` and `b` until both have ended. */
static void relay(int a, int b) {
	int open_a = 1, open_b = 1;
	char buffer[65536];
	while (open_a || open_b) {
		struct pollfd fds[2] = {{.fd = open_a ? a : -1, .events = POLLIN},
			{.fd = open_b ? b : -1, .events = POLLIN}};
		if (poll(fds, 2, -1) < 0) {
			if (errno == EINTR) continue;
			break;
		}
		for (int side = 0; side < 2; side++) {
			if (!(fds[side].revents & (POLLIN | POLLHUP | POLLERR))) continue;
			int from = side ? b : a, to = side ? a : b;
			ssize_t got = read(from, buffer, sizeof buffer);
			if (got <= 0) {
				shutdown(to, SHUT_WR);
				if (side) open_b = 0;
				else open_a = 0;
				continue;
			}
			for (ssize_t sent = 0; sent < got;) {
				ssize_t wrote = write(to, buffer + sent, got - sent);
				if (wrote <= 0) return;
				sent += wrote;
			}
		}
	}
}

/*
 * The guest's way out: 10.0.0.1:<port>, relayed to the host over vsock, where `chopin-vz` connects
 * each connection to the connector's proxy on host loopback and nowhere else.
 */
static void start_proxy_relay(int port) {
	pid_t pid = fork();
	if (pid < 0) fail("couldn't fork the proxy relay: %s", strerror(errno));
	if (pid > 0) return;
	close(control);
	signal(SIGCHLD, SIG_IGN);
	int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
	int yes = 1;
	setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
	struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(port)};
	inet_pton(AF_INET, GATEWAY, &address.sin_addr);
	if (bind(listener, (struct sockaddr *)&address, sizeof address) != 0 || listen(listener, 128) != 0) {
		say("chopin-init: the proxy relay couldn't listen: %s", strerror(errno));
		_exit(1);
	}
	/* It needs nothing of root's once it listens. */
	setgroups(0, NULL);
	if (setgid(65534) != 0 || setuid(65534) != 0) _exit(1);
	for (;;) {
		int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
		if (client < 0) continue;
		if (fork() == 0) {
			close(listener);
			int host = vsock_connect(PORT_PROXY, 5);
			if (host >= 0) relay(client, host);
			_exit(0);
		}
		close(client);
	}
}

/*
 * A process that copies `from` to `to` until `from` ends, then says so to `to`'s reader: one of the
 * workload's streams, between its pipe and the host.
 */
static pid_t start_stream(int from, int to) {
	pid_t pid = fork();
	if (pid < 0) fail("couldn't fork a stream: %s", strerror(errno));
	if (pid > 0) return pid;
	dup2(from, 0);
	dup2(to, 1);
	syscall(SYS_close_range, 3, ~0U, 0);
	char buffer[65536];
	for (;;) {
		ssize_t got = read(0, buffer, sizeof buffer);
		if (got < 0 && errno == EINTR) continue;
		if (got <= 0) break;
		for (ssize_t sent = 0; sent < got;) {
			ssize_t wrote = write(1, buffer + sent, got - sent);
			if (wrote < 0 && errno == EINTR) continue;
			if (wrote <= 0) _exit(0);
			sent += wrote;
		}
	}
	shutdown(1, SHUT_WR);
	close(1);
	_exit(0);
}

static int status_code(int status) {
	if (WIFEXITED(status)) return WEXITSTATUS(status);
	if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
	return 1;
}

int main(void) {
	mount("devtmpfs", "/dev", "devtmpfs", 0, NULL);
	mount("proc", "/proc", "proc", 0, NULL);
	mount("sysfs", "/sys", "sysfs", 0, NULL);
	load_modules();
	control = vsock_connect(PORT_CONTROL, 500);
	if (control < 0) fail("couldn't reach the host over vsock");
	Words words = read_configuration();

	const char *hostname = "chopin", *user = "", *cwd = "/", *upper = "ram", *percent = "50";
	int proxy = 0;
	Share shares[MOST];
	size_t share_count = 0;
	const char *denied[MOST];
	size_t denied_count = 0;
	char *environment[4096];
	size_t environment_count = 0;
	char *arguments[4096];
	size_t argument_count = 0;
	for (;;) {
		const char *key = next(&words);
		if (!strcmp(key, "end")) break;
		if (!strcmp(key, "time")) {
			struct timespec now = {.tv_sec = atoll(next(&words)), .tv_nsec = atol(next(&words))};
			clock_settime(CLOCK_REALTIME, &now);
		} else if (!strcmp(key, "hostname")) hostname = next(&words);
		else if (!strcmp(key, "user")) user = next(&words);
		else if (!strcmp(key, "cwd")) cwd = next(&words);
		else if (!strcmp(key, "upper")) {
			upper = next(&words);
			percent = next(&words);
		} else if (!strcmp(key, "proxy")) proxy = atoi(next(&words));
		else if (!strcmp(key, "share")) {
			if (share_count == MOST) fail("too many shares");
			Share *share = &shares[share_count++];
			share->tag = next(&words);
			share->guest = next(&words);
			share->read_only = !strcmp(next(&words), "ro");
			share->file = next(&words);
		} else if (!strcmp(key, "deny")) {
			if (denied_count == MOST) fail("too many denied paths");
			denied[denied_count++] = next(&words);
		} else if (!strcmp(key, "env")) {
			if (environment_count == 4095) fail("too many variables");
			environment[environment_count++] = (char *)next(&words);
		} else if (!strcmp(key, "arg")) {
			if (argument_count == 4095) fail("too many arguments");
			arguments[argument_count++] = (char *)next(&words);
		} else fail("unknown configuration word %s", key);
	}
	environment[environment_count] = NULL;
	arguments[argument_count] = NULL;
	if (!argument_count) fail("no command");

	/* The image's layer under an upper in memory or on the launch's disk. */
	wait_for("/dev/vda");
	make_folders("/lower");
	must_mount("/dev/vda", "/lower", "erofs", MS_RDONLY, NULL);
	make_folders("/up");
	if (!strcmp(upper, "disk")) {
		wait_for("/dev/vdb");
		must_mount("/dev/vdb", "/up", "ext4", MS_NOATIME, NULL);
	} else {
		char options[64];
		snprintf(options, sizeof options, "size=%s%%,mode=0755", percent);
		must_mount("tmpfs", "/up", "tmpfs", 0, options);
	}
	make_folders("/up/upper");
	make_folders("/up/work");
	make_folders("/root");
	must_mount("overlay", "/root", "overlay", 0, "lowerdir=/lower,upperdir=/up/upper,workdir=/up/work");

	/* What every Linux system has, in the new root. */
	make_folders("/root/proc");
	must_mount("proc", "/root/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL);
	make_folders("/root/sys");
	must_mount("sysfs", "/root/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY, NULL);
	make_folders("/root/dev");
	must_mount("devtmpfs", "/root/dev", "devtmpfs", MS_NOSUID, NULL);
	make_folders("/root/dev/pts");
	mount("devpts", "/root/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC, "ptmxmode=0666,mode=0620");
	make_folders("/root/dev/shm");
	mount("tmpfs", "/root/dev/shm", "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777");
	make_folders("/root/run");
	must_mount("tmpfs", "/root/run", "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755");
	make_folders("/root/tmp");
	chmod("/root/tmp", 01777);

	/* The shares, where the launch says; a single file is shared as its own folder, then bound. */
	char path[4096];
	for (size_t index = 0; index < share_count; index++) {
		Share *share = &shares[index];
		unsigned long flags = MS_NOSUID | MS_NODEV | (share->read_only ? MS_RDONLY : 0);
		snprintf(path, sizeof path, "/root%s", share->guest);
		if (!*share->file) {
			make_folders(path);
			must_mount(share->tag, path, "virtiofs", flags, NULL);
			continue;
		}
		char folder[600];
		snprintf(folder, sizeof folder, "/files/%s", share->tag);
		make_folders(folder);
		must_mount(share->tag, folder, "virtiofs", flags | MS_RDONLY, NULL);
		char parent[4096];
		snprintf(parent, sizeof parent, "%s", path);
		*strrchr(parent, '/') = 0;
		make_folders(parent);
		int made = open(path, O_CREAT | O_WRONLY | O_CLOEXEC, 0644);
		if (made >= 0) close(made);
		char file[1200];
		snprintf(file, sizeof file, "%s/%s", folder, share->file);
		must_mount(file, path, NULL, MS_BIND, NULL);
		must_mount(NULL, path, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL);
	}
	/* What the launch hides inside its shares: an empty, unreadable folder or file over each. */
	int empty = open("/empty", O_CREAT | O_WRONLY | O_CLOEXEC, 0);
	if (empty >= 0) close(empty);
	for (size_t index = 0; index < denied_count; index++) {
		snprintf(path, sizeof path, "/root%s", denied[index]);
		struct stat found;
		if (lstat(path, &found) != 0) continue;
		if (S_ISDIR(found.st_mode)) {
			must_mount("tmpfs", path, "tmpfs", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=4k,mode=000");
		} else {
			must_mount("/empty", path, NULL, MS_BIND, NULL);
			must_mount(NULL, path, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL);
		}
	}

	(void)!sethostname(hostname, strlen(hostname));
	bring_up_loopback();

	/* Into the new root, for good. */
	if (chdir("/root") != 0) fail("no /root");
	must_mount(".", "/", NULL, MS_MOVE, NULL);
	if (chroot(".") != 0 || chdir("/") != 0) fail("couldn't move into the root: %s", strerror(errno));

	if (proxy > 0) start_proxy_relay(proxy);

	int input = vsock_connect(PORT_STDIN, 50);
	int output = vsock_connect(PORT_STDOUT, 50);
	int errors = vsock_connect(PORT_STDERR, 50);
	if (input < 0 || output < 0 || errors < 0) fail("couldn't open the workload's streams");

	uid_t uid = 65534;
	gid_t gid = 65534;
	if (*user && sscanf(user, "%u:%u", &uid, &gid) != 2) fail("bad user %s", user);

	/*
	 * The workload gets pipes, as a program started by the connector on the host would: a vsock
	 * socket isn't a stream every runtime writes to whole (Node drops what is pending on one as it
	 * exits). Three relays copy between the pipes and the host.
	 */
	int stdin_pipe[2], stdout_pipe[2], stderr_pipe[2];
	if (pipe2(stdin_pipe, O_CLOEXEC) || pipe2(stdout_pipe, O_CLOEXEC) || pipe2(stderr_pipe, O_CLOEXEC)) {
		fail("no pipes: %s", strerror(errno));
	}
	pid_t relays[3] = {
		start_stream(input, stdin_pipe[1]),
		start_stream(stdout_pipe[0], output),
		start_stream(stderr_pipe[0], errors),
	};

	pid_t workload = fork();
	if (workload < 0) fail("couldn't fork: %s", strerror(errno));
	if (workload == 0) {
		setsid();
		dup2(stdin_pipe[0], 0);
		dup2(stdout_pipe[1], 1);
		dup2(stderr_pipe[1], 2);
		syscall(SYS_close_range, 3, ~0U, 0);
		if (setgroups(1, &gid) != 0 || setgid(gid) != 0 || setuid(uid) != 0) {
			dprintf(2, "chopin-init: couldn't become %u:%u: %s\n", uid, gid, strerror(errno));
			_exit(126);
		}
		if (chdir(cwd) != 0) {
			dprintf(2, "chopin-init: couldn't enter %s: %s\n", cwd, strerror(errno));
			_exit(126);
		}
		umask(022);
		execve(arguments[0], arguments, environment);
		dprintf(2, "chopin-init: couldn't run %s: %s\n", arguments[0], strerror(errno));
		_exit(127);
	}
	close(input);
	close(output);
	close(errors);
	for (int index = 0; index < 2; index++) {
		close(stdin_pipe[index]);
		close(stdout_pipe[index]);
		close(stderr_pipe[index]);
	}

	/* Reap everything, as the first process does, until the workload ends or the host says stop. */
	int code = -1;
	int terminated = 0;
	int streaming = 2;
	struct timespec ended_at = {0};
	for (;;) {
		int status;
		pid_t ended;
		while ((ended = waitpid(-1, &status, WNOHANG)) > 0) {
			if (ended == workload) {
				code = status_code(status);
				clock_gettime(CLOCK_MONOTONIC, &ended_at);
			}
			if (ended == relays[1] || ended == relays[2]) streaming--;
		}
		if (code >= 0) {
			/* What it printed reaches the host first, unless what it left behind holds its pipes. */
			struct timespec now;
			clock_gettime(CLOCK_MONOTONIC, &now);
			if (streaming == 0 || now.tv_sec - ended_at.tv_sec >= 2) break;
		}
		struct pollfd watch = {.fd = control, .events = POLLIN};
		if (poll(&watch, 1, code >= 0 ? 10 : 100) > 0) {
			char message[64];
			ssize_t got = read(control, message, sizeof message);
			if (got <= 0) {
				/* The host is gone: nothing may outlive it. */
				kill(-1, SIGKILL);
				power_off();
			}
			message[got < (ssize_t)sizeof message ? got : (ssize_t)sizeof message - 1] = 0;
			long long seconds;
			long nanoseconds;
			if (!terminated && strstr(message, "term")) {
				terminated = 1;
				kill(-workload, SIGTERM);
				kill(workload, SIGTERM);
			} else if (sscanf(message, "time %lld %ld", &seconds, &nanoseconds) == 2) {
				/* The host's clock, told again each minute: the guest has none to follow. */
				struct timespec now = {.tv_sec = seconds, .tv_nsec = nanoseconds};
				clock_settime(CLOCK_REALTIME, &now);
			}
		}
	}
	/* Nothing the workload left behind outlives it, and the disk has what it wrote. */
	kill(-1, SIGKILL);
	while (waitpid(-1, NULL, WNOHANG) > 0) {}
	sync();
	char line[32];
	int length = snprintf(line, sizeof line, "exit %d\n", code);
	(void)!write(control, line, length);
	/* The host stops the VM once it has read what the workload printed; this is a backstop. */
	struct pollfd watch = {.fd = control, .events = POLLIN};
	poll(&watch, 1, 5000);
	power_off();
	return 0;
}
