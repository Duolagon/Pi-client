/* Own a real POSIX pseudoterminal and bridge framed host input to its master. */
#define _DEFAULT_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif

#define MAX_FRAME (1024 * 1024)
#define MAX_PENDING (4 * 1024 * 1024)
static volatile sig_atomic_t stopping = 0;
static void stop_signal(int signal_number) { (void)signal_number; stopping = 1; }
static long long now_ms(void) {
	struct timeval value;
	gettimeofday(&value, NULL);
	return (long long)value.tv_sec * 1000 + value.tv_usec / 1000;
}
static uint32_t read_u32(const unsigned char *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) | bytes[3];
}
static int write_all(int fd, const unsigned char *bytes, size_t length) {
	while (length > 0) {
		ssize_t count = write(fd, bytes, length);
		if (count < 0 && errno == EINTR) continue;
		if (count <= 0) return -1;
		bytes += count;
		length -= (size_t)count;
	}
	return 0;
}
static void kill_terminal(int master, pid_t child, int signal_number) {
	pid_t foreground = tcgetpgrp(master);
	if (foreground > 0) kill(-foreground, signal_number);
	kill(-child, signal_number);
	kill(child, signal_number);
}
static int positive_size(const char *value) {
	char *end;
	long parsed = strtol(value, &end, 10);
	return *value && !*end && parsed >= 1 && parsed <= 1000 ? (int)parsed : 0;
}
static int fail(const char *message) {
	fprintf(stderr, "{\"type\":\"error\",\"message\":\"%s\"}\n", message);
	return 1;
}

int main(int argc, char **argv) {
	if (argc < 4 || argv[1][0] != '/') return fail("Invalid PTY helper arguments");
	int cols = positive_size(argv[2]), rows = positive_size(argv[3]);
	if (!cols || !rows) return fail("Invalid terminal dimensions");
	struct winsize size;
	memset(&size, 0, sizeof(size));
	size.ws_col = (unsigned short)cols;
	size.ws_row = (unsigned short)rows;
	int exec_status[2];
	if (pipe(exec_status) < 0) return fail("Cannot create terminal startup channel");
	fcntl(exec_status[1], F_SETFD, FD_CLOEXEC);
	int master;
	pid_t child = forkpty(&master, NULL, NULL, &size);
	if (child < 0) { close(exec_status[0]); close(exec_status[1]); return fail("Cannot create pseudoterminal"); }
	if (child == 0) {
		/* forkpty creates a session and controlling terminal before exec. */
		close(exec_status[0]);
		signal(SIGPIPE, SIG_DFL);
		if (argc == 4) {
			execl(argv[1], argv[1], "-l", "-i", (char *)NULL);
		} else {
			argv[3] = argv[1];
			execv(argv[1], &argv[3]);
		}
		int error = errno;
		write_all(exec_status[1], (const unsigned char *)&error, sizeof(error));
		_exit(127);
	}
	close(exec_status[1]);
	int exec_error;
	ssize_t startup;
	do { startup = read(exec_status[0], &exec_error, sizeof(exec_error)); } while (startup < 0 && errno == EINTR);
	close(exec_status[0]);
	if (startup != 0) {
		kill_terminal(master, child, SIGKILL);
		waitpid(child, NULL, 0);
		close(master);
		return fail("Cannot execute terminal shell");
	}
	signal(SIGPIPE, SIG_IGN);
	signal(SIGTERM, stop_signal);
	signal(SIGHUP, stop_signal);
	signal(SIGINT, stop_signal);
	fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
	unsigned char *frames = malloc(MAX_FRAME + 65541);
	unsigned char *pending = malloc(MAX_PENDING);
	if (!frames || !pending) {
		kill_terminal(master, child, SIGKILL);
		waitpid(child, NULL, 0);
		return fail("Cannot allocate terminal buffers");
	}
	size_t frame_length = 0, pending_length = 0;
	int child_done = 0, status = 0, master_done = 0;
	long long stop_started = 0, exit_started = 0;
	fprintf(stderr, "{\"type\":\"ready\",\"pid\":%ld}\n", (long)child);
	fflush(stderr);
	while (!child_done || (!master_done && now_ms() - exit_started < 250)) {
		if (stopping && !stop_started) {
			stop_started = now_ms();
			kill_terminal(master, child, SIGHUP);
		}
		if (stop_started && !child_done) {
			long long elapsed = now_ms() - stop_started;
			if (elapsed >= 1000) kill_terminal(master, child, SIGKILL);
			else if (elapsed >= 300) kill_terminal(master, child, SIGTERM);
		}
		struct pollfd fds[2] = {
			/* Leave room for a complete frame plus the next read before accepting more input. */
			{ .fd = stopping || child_done || pending_length > MAX_PENDING - MAX_FRAME - 65536 ? -1 : STDIN_FILENO, .events = POLLIN },
			{ .fd = master_done ? -1 : master, .events = POLLIN | (pending_length ? POLLOUT : 0) }
		};
		int polled = poll(fds, 2, 50);
		if (polled < 0 && errno != EINTR) stopping = 1;
		if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) stopping = 1;
		if (fds[0].revents & POLLIN) {
			ssize_t count = read(STDIN_FILENO, frames + frame_length, 65536);
			if (count <= 0) stopping = 1;
			else frame_length += (size_t)count;
			size_t consumed = 0;
			while (frame_length - consumed >= 5) {
				unsigned char kind = frames[consumed];
				uint32_t length = read_u32(frames + consumed + 1);
				if (length > MAX_FRAME) { stopping = 1; break; }
				if (frame_length - consumed < 5 + length) break;
				unsigned char *payload = frames + consumed + 5;
				if (kind == 1) {
					if (pending_length + length > MAX_PENDING) { stopping = 1; break; }
					memcpy(pending + pending_length, payload, length);
					pending_length += length;
				} else if (kind == 2 && length == 8) {
					uint32_t next_cols = read_u32(payload), next_rows = read_u32(payload + 4);
					if (!next_cols || next_cols > 1000 || !next_rows || next_rows > 1000) { stopping = 1; break; }
					size.ws_col = (unsigned short)next_cols;
					size.ws_row = (unsigned short)next_rows;
					if (ioctl(master, TIOCSWINSZ, &size) < 0) stopping = 1;
				} else if (kind == 3 && length == 0) stopping = 1;
				else { stopping = 1; break; }
				consumed += 5 + length;
			}
			if (consumed) {
				memmove(frames, frames + consumed, frame_length - consumed);
				frame_length -= consumed;
			}
			if (frame_length > MAX_FRAME + 5) stopping = 1;
		}
		if (fds[1].revents & POLLOUT && pending_length && !stopping) {
			ssize_t count = write(master, pending, pending_length);
			if (count > 0) {
				memmove(pending, pending + count, pending_length - (size_t)count);
				pending_length -= (size_t)count;
			} else if (count < 0 && errno != EINTR && errno != EAGAIN) stopping = 1;
		}
		if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
			unsigned char output[32768];
			ssize_t count = read(master, output, sizeof(output));
			if (count > 0) {
				if (write_all(STDOUT_FILENO, output, (size_t)count) < 0) stopping = 1;
			} else if (count == 0 || (errno != EAGAIN && errno != EINTR)) {
				master_done = 1;
				stopping = 1;
			}
		}
		if (!child_done && waitpid(child, &status, WNOHANG) == child) {
			child_done = 1;
			exit_started = now_ms();
		}
	}
	/* A foreground job can outlive a shell that was explicitly exited. */
	kill_terminal(master, child, SIGHUP);
	close(master);
	free(frames);
	free(pending);
	if (WIFEXITED(status)) fprintf(stderr, "{\"type\":\"exit\",\"exitCode\":%d,\"signal\":null}\n", WEXITSTATUS(status));
	else fprintf(stderr, "{\"type\":\"exit\",\"exitCode\":null,\"signal\":%d}\n", WTERMSIG(status));
	return 0;
}
