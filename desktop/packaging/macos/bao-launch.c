#define _POSIX_C_SOURCE 200809L
/* flock and LOCK_EX are BSD. This SDK hides them when only POSIX is requested. */
#define _DARWIN_C_SOURCE

#include "bao-launch.h"

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
extern long syscall(long number, ...);
#endif
#if defined(__APPLE__)
#include <libproc.h>
#endif

/* sys/types.h's major() macro would rewrite hooks->major(...). */
#undef major

static int lock_fd = -1;

static int path_join(char *out, size_t n, const char *a, const char *b) {
  int wrote = snprintf(out, n, "%s/%s", a, b);
  if (wrote < 0 || (size_t)wrote >= n) return -1;
  return 0;
}

int bao_parse_version(const char *text, BaoVer *out) {
  if (!out) return 0;
  out->major = 0;
  out->minor = 0;
  out->patch = 0;
  out->ok = 0;
  if (!text) return 0;
  while (*text == ' ' || *text == '\t' || *text == '\n' || *text == '\r') text++;
  if (*text == 'v' || *text == 'V') text++;
  char *end = NULL;
  long major = strtol(text, &end, 10);
  if (end == text || major < 0 || major > 1000) return 0;
  out->major = (int)major;
  out->ok = 1;
  if (*end != '.') return 1;
  text = end + 1;
  long minor = strtol(text, &end, 10);
  if (end == text || minor < 0 || minor > 100000) return 1;
  out->minor = (int)minor;
  if (*end != '.') return 1;
  text = end + 1;
  long patch = strtol(text, &end, 10);
  if (end == text || patch < 0 || patch > 100000) return 1;
  out->patch = (int)patch;
  return 1;
}

int bao_version_cmp(BaoVer a, BaoVer b) {
  if (a.major != b.major) return a.major < b.major ? -1 : 1;
  if (a.minor != b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch != b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

int bao_accept_shell_output(const char *text, char *out, size_t n) {
  if (!text || !out || n == 0) return 0;
  const char *last = NULL;
  size_t last_len = 0;
  const char *p = text;
  while (*p) {
    while (*p == '\n' || *p == '\r') p++;
    if (!*p) break;
    const char *start = p;
    while (*p && *p != '\n' && *p != '\r') p++;
    const char *end = p;
    while (start < end && (*start == ' ' || *start == '\t')) start++;
    while (end > start && (end[-1] == ' ' || end[-1] == '\t')) end--;
    size_t len = (size_t)(end - start);
    if (len >= 5 && strncmp(start, "alias", 5) == 0 && (len == 5 || start[5] == ' ' || start[5] == '\t' || start[5] == '=')) {
      return 0;
    }
    if (len > 1 && start[0] == '/' && memchr(start, ' ', len) == NULL) {
      last = start;
      last_len = len;
    }
  }
  if (!last || last_len + 1 > n) return 0;
  memcpy(out, last, last_len);
  out[last_len] = 0;
  return 1;
}

const char *bao_login_shell(const char *env_shell, int (*is_exec)(const char *path, void *ctx), void *ctx) {
  if (!is_exec) return NULL;
  if (env_shell && env_shell[0] == '/' && is_exec(env_shell, ctx)) return env_shell;
  if (is_exec("/bin/zsh", ctx)) return "/bin/zsh";
  if (is_exec("/bin/bash", ctx)) return "/bin/bash";
  return NULL;
}

static int try_file(const char *path, const BaoDiscoverHooks *hooks, char *out, size_t n) {
  if (!path || path[0] != '/' || !hooks || !hooks->is_exec || !hooks->major) return -1;
  if (!hooks->is_exec(path, hooks->ctx)) return -1;
  if (hooks->major(path, hooks->ctx) < 24) return -1;
  if (strlen(path) + 1 > n) return -1;
  memcpy(out, path, strlen(path) + 1);
  return 0;
}

static int best_tree(const char *root, const BaoDiscoverHooks *hooks, char *out, size_t n) {
  if (!root || !hooks || !hooks->is_exec) return -1;
  DIR *dir = opendir(root);
  if (!dir) return -1;
  BaoVer best;
  memset(&best, 0, sizeof best);
  char best_path[4096];
  best_path[0] = 0;
  int found = 0;
  struct dirent *ent;
  while ((ent = readdir(dir)) != NULL) {
    if (ent->d_name[0] == '.') continue;
    char version_dir[4096];
    char node[4096];
    if (path_join(version_dir, sizeof version_dir, root, ent->d_name) != 0) continue;
    struct stat st;
    if (stat(version_dir, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
    if (path_join(node, sizeof node, version_dir, "bin/node") != 0) continue;
    if (!hooks->is_exec(node, hooks->ctx)) continue;
    BaoVer ver;
    int named = bao_parse_version(ent->d_name, &ver);
    if (named && ver.major < 24) continue;
    int reported = hooks->major ? hooks->major(node, hooks->ctx) : (named ? ver.major : -1);
    if (reported < 24) continue;
    if (!named) {
      ver.major = reported;
      ver.minor = 0;
      ver.patch = 0;
      ver.ok = 1;
    }
    if (!found || bao_version_cmp(ver, best) > 0) {
      found = 1;
      best = ver;
      snprintf(best_path, sizeof best_path, "%s", node);
    }
  }
  closedir(dir);
  if (!found || best_path[0] == 0 || strlen(best_path) + 1 > n) return -1;
  memcpy(out, best_path, strlen(best_path) + 1);
  return 0;
}

int bao_discover_node(const char *bao_node, const char *home, const char *env_shell,
                      const BaoDiscoverHooks *hooks, char *out, size_t out_n) {
  if (!hooks || !out || out_n == 0) return -1;
  out[0] = 0;
  if (bao_node && bao_node[0] && try_file(bao_node, hooks, out, out_n) == 0) return 0;
  if (try_file("/opt/homebrew/bin/node", hooks, out, out_n) == 0) return 0;
  if (try_file("/usr/local/bin/node", hooks, out, out_n) == 0) return 0;
  /* `brew install node@24` is keg-only. It does not link into bin/. */
  if (try_file("/opt/homebrew/opt/node@24/bin/node", hooks, out, out_n) == 0) return 0;
  if (try_file("/usr/local/opt/node@24/bin/node", hooks, out, out_n) == 0) return 0;
  if (home && home[0]) {
    char root[4096];
    if (path_join(root, sizeof root, home, ".local/share/mise/installs/node") == 0 &&
        best_tree(root, hooks, out, out_n) == 0) return 0;
    if (path_join(root, sizeof root, home, ".nvm/versions/node") == 0 &&
        best_tree(root, hooks, out, out_n) == 0) return 0;
    if (path_join(root, sizeof root, home, ".volta/tools/image/node") == 0 &&
        best_tree(root, hooks, out, out_n) == 0) return 0;
    if (path_join(root, sizeof root, home, ".volta/bin/node") == 0 &&
        try_file(root, hooks, out, out_n) == 0) return 0;
  }
  const char *shell = bao_login_shell(env_shell, hooks->is_exec, hooks->ctx);
  if (!shell || !hooks->shell) return -1;
  char raw[4096];
  raw[0] = 0;
  if (hooks->shell(shell, raw, sizeof raw, hooks->ctx) != 0) return -1;
  char picked[4096];
  if (!bao_accept_shell_output(raw, picked, sizeof picked)) return -1;
  return try_file(picked, hooks, out, out_n);
}

/* The passwd directory is copied because getpwuid reuses one buffer. */
void bao_user_home(char *out, size_t n) {
  if (!out || n == 0) return;
  out[0] = '\0';
  const char *env = getenv("HOME");
  const char *dir = (env && env[0] == '/') ? env : NULL;
  if (!dir) {
    struct passwd *pw = getpwuid(getuid());
    if (pw && pw->pw_dir && pw->pw_dir[0] == '/') dir = pw->pw_dir;
  }
  if (!dir) return;
  size_t len = strlen(dir);
  if (len + 1 > n) return;
  memcpy(out, dir, len + 1);
}

int bao_find_browser(char *out, size_t n, const char *resources) {
  if (!out || n == 0 || !resources) return 0;
  char dir[4096];
  if (path_join(dir, sizeof dir, resources, "Chromium.app/Contents/MacOS") != 0) return 0;
  const char *names[] = {"Chromium", "Google Chrome for Testing", "chrome"};
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    if (path_join(out, n, dir, names[i]) != 0) continue;
    if (access(out, X_OK) == 0) return 1;
  }
  out[0] = '\0';
  return 0;
}

int bao_real_is_exec(const char *path, void *ctx) {
  (void)ctx;
  if (!path || path[0] != '/') return 0;
  struct stat st;
  if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
  return access(path, X_OK) == 0;
}

static int mono_now(struct timespec *out) {
  /* A pending signal makes glibc retry clock_gettime and never return, so the
     deadline would be anchored after the storm. Block signals for the read. */
  sigset_t block, old;
  sigfillset(&block);
  if (sigprocmask(SIG_BLOCK, &block, &old) != 0) return clock_gettime(CLOCK_MONOTONIC, out);
  int rc = clock_gettime(CLOCK_MONOTONIC, out);
  sigprocmask(SIG_SETMASK, &old, NULL);
  return rc;
}

static void mono_add_ms(struct timespec *ts, int ms) {
  if (ms < 0) ms = 0;
  ts->tv_sec += ms / 1000;
  long nsec = ts->tv_nsec + (long)(ms % 1000) * 1000000L;
  ts->tv_sec += nsec / 1000000000L;
  ts->tv_nsec = nsec % 1000000000L;
}

static int mono_reached(const struct timespec *deadline) {
  struct timespec now;
  if (mono_now(&now) != 0) return 1;
  if (now.tv_sec != deadline->tv_sec) return now.tv_sec > deadline->tv_sec;
  return now.tv_nsec >= deadline->tv_nsec;
}

static int mono_left_ms(const struct timespec *deadline) {
  struct timespec now;
  if (mono_now(&now) != 0) return 0;
  long sec = (long)deadline->tv_sec - (long)now.tv_sec;
  long nsec = deadline->tv_nsec - now.tv_nsec;
  if (nsec < 0) {
    sec--;
    nsec += 1000000000L;
  }
  if (sec < 0) return 0;
  if (sec > 1000L) return 1000000;
  long ms = sec * 1000L + nsec / 1000000L;
  if (ms > 1000000L) return 1000000;
  return (int)ms;
}

static void sleep_once(const struct timespec *deadline, int cap_ms) {
  struct timespec now;
  if (mono_now(&now) != 0) return;
  struct timespec wake = now;
  mono_add_ms(&wake, cap_ms);
  if (wake.tv_sec > deadline->tv_sec || (wake.tv_sec == deadline->tv_sec && wake.tv_nsec > deadline->tv_nsec)) {
    wake = *deadline;
  }
  sigset_t block, old;
  sigfillset(&block);
  int masked = sigprocmask(SIG_BLOCK, &block, &old) == 0;
#if defined(__linux__)
  syscall(SYS_clock_nanosleep, CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, NULL);
#elif defined(TIMER_ABSTIME)
  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, NULL);
#else
  long sec = (long)wake.tv_sec - (long)now.tv_sec;
  long nsec = wake.tv_nsec - now.tv_nsec;
  if (nsec < 0) {
    sec--;
    nsec += 1000000000L;
  }
  if (sec >= 0) {
    struct timespec ts;
    ts.tv_sec = sec;
    ts.tv_nsec = nsec;
    nanosleep(&ts, NULL);
  }
#endif
  if (masked) sigprocmask(SIG_SETMASK, &old, NULL);
}

enum capture_drain {
  drain_interrupt = -1,
  drain_writers_remain = 0,
  drain_writers_gone = 1
};

/* 1 when every writer has closed, 0 when a writer still holds the pipe or the
   deadline has arrived, -1 when a signal interrupted the read. */
static int capture_drain(int fd, char *buf, size_t n, size_t *used, const struct timespec *deadline) {
  for (;;) {
    if (mono_reached(deadline)) return drain_writers_remain;
    char tmp[512];
    ssize_t got = read(fd, tmp, sizeof tmp);
    if (got < 0 && errno == EINTR) return drain_interrupt;
    if (got < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return drain_writers_remain;
    if (got <= 0) return drain_writers_gone;
    size_t room = n - 1 - *used;
    size_t take = (size_t)got < room ? (size_t)got : room;
    if (take > 0) {
      memcpy(buf + *used, tmp, take);
      *used += take;
      buf[*used] = 0;
    }
  }
}

static void kill_group(pid_t pid, int reaped) {
  kill(-pid, SIGKILL);
  if (!reaped) kill(pid, SIGKILL);
}

#if defined(__linux__)
static int pipe_link_matches(const char *linkpath, const char *mine) {
  char target[64];
  ssize_t n = readlink(linkpath, target, sizeof target - 1);
  if (n < 0 || (size_t)n >= sizeof target - 1) return 0;
  target[n] = 0;
  return strcmp(target, mine) == 0;
}

static void kill_pipe_writers(int fd) {
  char selfpath[64];
  char mine[64];
  snprintf(selfpath, sizeof selfpath, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(selfpath, mine, sizeof mine - 1);
  if (n < 0 || (size_t)n >= sizeof mine - 1) return;
  mine[n] = 0;
  if (strncmp(mine, "pipe:", 5) != 0) return;
  pid_t self = getpid();
  DIR *proc = opendir("/proc");
  if (!proc) return;
  struct dirent *ent;
  while ((ent = readdir(proc)) != NULL) {
    if (ent->d_name[0] < '1' || ent->d_name[0] > '9') continue;
    char *end = NULL;
    long pid = strtol(ent->d_name, &end, 10);
    if (!end || *end != '\0' || pid <= 1 || pid == (long)self) continue;
    char fdpath[64];
    snprintf(fdpath, sizeof fdpath, "/proc/%ld/fd", pid);
    DIR *fds = opendir(fdpath);
    if (!fds) continue;
    int matched = 0;
    struct dirent *fdent;
    while ((fdent = readdir(fds)) != NULL) {
      if (fdent->d_name[0] == '.') continue;
      char link[96];
      int wrote = snprintf(link, sizeof link, "%s/%s", fdpath, fdent->d_name);
      if (wrote < 0 || (size_t)wrote >= sizeof link) continue;
      if (pipe_link_matches(link, mine)) {
        matched = 1;
        break;
      }
    }
    closedir(fds);
    if (matched) kill((pid_t)pid, SIGKILL);
  }
  closedir(proc);
}
#elif defined(__APPLE__)
#ifndef PROC_FDTYPE_PIPE
#ifdef PROX_FDTYPE_PIPE
#define PROC_FDTYPE_PIPE PROX_FDTYPE_PIPE
#else
#define PROC_FDTYPE_PIPE 6
#endif
#endif

static void kill_pipe_writers(int fd) {
  struct pipe_fdinfo mine;
  int got = proc_pidfdinfo(getpid(), fd, PROC_PIDFDPIPEINFO, &mine, (int)sizeof mine);
  if (got != (int)sizeof mine || mine.pipeinfo.pipe_peerhandle == 0) return;
  uint64_t peer = mine.pipeinfo.pipe_peerhandle;
  pid_t self = getpid();
  int need = proc_listallpids(NULL, 0);
  if (need <= 0) return;
  need += 32;
  pid_t *pids = calloc((size_t)need, sizeof *pids);
  if (!pids) return;
  int count = proc_listallpids(pids, need * (int)sizeof *pids);
  if (count < 0) count = 0;
  if (count > need) count = need;
  for (int i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 1 || pid == self) continue;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (bytes <= 0) continue;
    struct proc_fdinfo *fds = malloc((size_t)bytes);
    if (!fds) continue;
    int filled = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, bytes);
    if (filled > bytes) filled = bytes;
    if (filled > 0) {
      int nfd = filled / (int)sizeof *fds;
      for (int j = 0; j < nfd; j++) {
        if (fds[j].proc_fdtype != PROC_FDTYPE_PIPE) continue;
        struct pipe_fdinfo info;
        int ninfo = proc_pidfdinfo(pid, fds[j].proc_fd, PROC_PIDFDPIPEINFO, &info, (int)sizeof info);
        if (ninfo == (int)sizeof info && info.pipeinfo.pipe_handle == peer) kill(pid, SIGKILL);
      }
    }
    free(fds);
  }
  free(pids);
}
#else
static void kill_pipe_writers(int fd) { (void)fd; }
#endif

static pid_t wait_child(pid_t pid, int *status) {
#if defined(__linux__)
  /* glibc waitpid retries after EINTR, so a signal storm never reaches the deadline. */
  return (pid_t)syscall(SYS_wait4, pid, status, WNOHANG, NULL);
#else
  return waitpid(pid, status, WNOHANG);
#endif
}

static int reap_bounded(pid_t pid, int fd, int *status, int reaped) {
  kill_group(pid, reaped);
  kill_pipe_writers(fd);
  struct timespec cleanup;
  if (mono_now(&cleanup) != 0) {
    close(fd);
    return -1;
  }
  mono_add_ms(&cleanup, 200);
  while (!reaped && !mono_reached(&cleanup)) {
    pid_t got = wait_child(pid, status);
    if (got == pid) reaped = 1;
    else if (got < 0 && errno != EINTR) break;
    else {
      sleep_once(&cleanup, 20);
    }
  }
  close(fd);
  return -1;
}

static void restore_mask(int masked, const sigset_t *saved) {
  if (masked) sigprocmask(SIG_SETMASK, saved, NULL);
}

/* The child sits in its own group so the deadline can signal that group
   without signaling the caller. A job that leaves the group can still hold
   the pipe. Those writers are the ones that have to stop. A daemon that
   closed the pipe is not part of the capture. */
static int capture_parent(pid_t pid, int fd, char *buf, size_t n, int timeout_ms) {
  setpgid(pid, pid);
  int status = 0;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    return reap_bounded(pid, fd, &status, 0);
  }
  size_t used = 0;
  buf[0] = 0;
  int reaped = 0;
  int eof = 0;
  struct timespec deadline;
  if (mono_now(&deadline) != 0) return reap_bounded(pid, fd, &status, reaped);
  mono_add_ms(&deadline, timeout_ms);
  int step = drain_writers_remain;
  for (;;) {
    if (!eof) step = capture_drain(fd, buf, n, &used, &deadline);
    if (step == drain_writers_gone) eof = 1;
    if (!reaped) {
      pid_t got = wait_child(pid, &status);
      if (got == pid) reaped = 1;
      else if (got < 0 && errno != EINTR) {
        reaped = 1;
        return reap_bounded(pid, fd, &status, reaped);
      }
    }
    if (reaped && !eof) {
      step = capture_drain(fd, buf, n, &used, &deadline);
      if (step == drain_writers_gone) eof = 1;
    }
    if (reaped && eof) break;
    if (reaped && step == drain_writers_remain) return reap_bounded(pid, fd, &status, reaped);
    if (mono_reached(&deadline) || mono_left_ms(&deadline) <= 0) break;
    if (step == drain_interrupt) continue;
    sleep_once(&deadline, 50);
  }
  if (reaped && eof) {
    close(fd);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;
    return 0;
  }
  return reap_bounded(pid, fd, &status, reaped);
}

int bao_run_capture(char *const argv[], char *buf, size_t n, int timeout_ms) {
  if (!argv || !argv[0] || !buf || n == 0) return -1;
  /* A tight signal storm runs the handler between every syscall, so the
     deadline is never read. Block signals for the whole parent capture.
     The child must not inherit that mask. */
  sigset_t saved_mask;
  sigset_t block;
  sigfillset(&block);
  int masked = sigprocmask(SIG_BLOCK, &block, &saved_mask) == 0;
  int pipefd[2];
  if (pipe(pipefd) != 0) {
    restore_mask(masked, &saved_mask);
    return -1;
  }
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    restore_mask(masked, &saved_mask);
    return -1;
  }
  if (pid == 0) {
    restore_mask(masked, &saved_mask);
    setpgid(0, 0);
    /* This group is not the terminal's foreground group, so a profile that
       runs `stty` or reads the tty gets SIGTTOU or SIGTTIN and stops until
       the deadline. Ignoring them is not enough: bash 3.2 (macOS /bin/sh)
       and zsh reset both to the default in every command they start. They
       keep the signal mask, and the tty treats a blocked SIGTTIN or SIGTTOU
       like an ignored one. dash clears the mask but keeps the ignore, so do
       both. */
    struct sigaction ignore_stop;
    memset(&ignore_stop, 0, sizeof ignore_stop);
    ignore_stop.sa_handler = SIG_IGN;
    sigemptyset(&ignore_stop.sa_mask);
    sigaction(SIGTTIN, &ignore_stop, NULL);
    sigaction(SIGTTOU, &ignore_stop, NULL);
    sigset_t tty_stop;
    sigemptyset(&tty_stop);
    sigaddset(&tty_stop, SIGTTIN);
    sigaddset(&tty_stop, SIGTTOU);
    sigprocmask(SIG_BLOCK, &tty_stop, NULL);
    if (dup2(pipefd[1], STDOUT_FILENO) < 0) _exit(127);
    int devnull = open("/dev/null", O_RDONLY);
    if (devnull >= 0) {
      dup2(devnull, STDIN_FILENO);
      close(devnull);
    }
    devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) {
      dup2(devnull, STDERR_FILENO);
      close(devnull);
    }
    close(pipefd[0]);
    close(pipefd[1]);
    execv(argv[0], argv);
    _exit(127);
  }
  close(pipefd[1]);
  int rc = capture_parent(pid, pipefd[0], buf, n, timeout_ms);
  restore_mask(masked, &saved_mask);
  return rc;
}

int bao_real_major(const char *path, void *ctx) {
  (void)ctx;
  if (!path || path[0] != '/') return -1;
  char *argv[] = {(char *)path, "-v", NULL};
  char buf[128];
  if (bao_run_capture(argv, buf, sizeof buf, 2000) != 0) return -1;
  BaoVer ver;
  if (!bao_parse_version(buf, &ver) || !ver.ok) return -1;
  return ver.major;
}

int bao_real_shell(const char *shell_path, char *buf, size_t n, void *ctx) {
  (void)ctx;
  if (!shell_path || shell_path[0] != '/' || !buf || n == 0) return -1;
  char *argv[] = {(char *)shell_path, "-lc", "command -v node", NULL};
  return bao_run_capture(argv, buf, n, 3000);
}

static int pid_path(const char *home, char *out, size_t n) {
  return path_join(out, n, home, "ui.pid");
}

int bao_read_browser_pid(const char *home) {
  if (!home || !home[0]) return -1;
  char path[4096];
  if (pid_path(home, path, sizeof path) != 0) return -1;
  FILE *file = fopen(path, "r");
  if (!file) return -1;
  long pid = -1;
  if (fscanf(file, "%ld", &pid) != 1) pid = -1;
  fclose(file);
  if (pid <= 0 || pid > 0x7fffffffL) return -1;
  return (int)pid;
}

int bao_instance_acquire(const char *home, int *other_pid) {
  if (other_pid) *other_pid = -1;
  if (!home || !home[0]) return -1;
  char path[4096];
  if (path_join(path, sizeof path, home, "instance.lock") != 0) return -1;
  int fd = open(path, O_RDWR | O_CREAT, 0600);
  if (fd < 0) return -1;
  fchmod(fd, 0600);
  int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
      lock_fd = fd;
      return 0;
    }
    if (errno == EINTR) continue;
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      if (other_pid) *other_pid = bao_read_browser_pid(home);
      close(fd);
      return 1;
    }
    close(fd);
    return -1;
  }
}

void bao_instance_release(void) {
  if (lock_fd < 0) return;
  close(lock_fd);
  lock_fd = -1;
}

int bao_instance_write_browser_pid(const char *home, int pid) {
  if (lock_fd < 0 || pid <= 0 || !home || !home[0]) return -1;
  char path[4096];
  if (pid_path(home, path, sizeof path) != 0) return -1;
  char body[32];
  int wrote = snprintf(body, sizeof body, "%d\n", pid);
  if (wrote < 0 || (size_t)wrote >= sizeof body) return -1;
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return -1;
  fchmod(fd, 0600);
  size_t left = (size_t)wrote;
  const char *p = body;
  while (left > 0) {
    ssize_t n = write(fd, p, left);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      close(fd);
      return -1;
    }
    p += n;
    left -= (size_t)n;
  }
  close(fd);
  return 0;
}

int bao_port_listening(const char *port) {
  if (!port || !port[0]) return 0;
  char *end = NULL;
  long parsed = strtol(port, &end, 10);
  if (end == port || *end != 0 || parsed <= 0 || parsed > 65535) return 0;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 0;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)parsed);
  if (inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr) != 1) {
    close(fd);
    return 0;
  }
  int ok = connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0;
  close(fd);
  return ok ? 1 : 0;
}

int bao_wait_for_port(const char *port, int child_pid, int timeout_ms) {
  if (timeout_ms < 0) timeout_ms = 0;
  int waited = 0;
  for (;;) {
    if (bao_port_listening(port)) return 0;
    if (child_pid > 0) {
      int status = 0;
      pid_t got = waitpid(child_pid, &status, WNOHANG);
      if (got == child_pid) return -1;
      if (got < 0 && errno != EINTR) return -1;
    }
    if (waited >= timeout_ms) return -1;
    struct timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = 50L * 1000L * 1000L;
    nanosleep(&ts, NULL);
    waited += 50;
  }
}
