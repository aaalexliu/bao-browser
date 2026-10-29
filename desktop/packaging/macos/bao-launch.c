#define _POSIX_C_SOURCE 200809L
/* flock and LOCK_EX are BSD. This SDK hides them when only POSIX is requested. */
#define _DARWIN_C_SOURCE

#include "bao-launch.h"

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
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

int bao_real_is_exec(const char *path, void *ctx) {
  (void)ctx;
  if (!path || path[0] != '/') return 0;
  struct stat st;
  if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
  return access(path, X_OK) == 0;
}

static int mono_now(struct timespec *out) {
  return clock_gettime(CLOCK_MONOTONIC, out);
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
#if defined(TIMER_ABSTIME)
  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, NULL);
#else
  long sec = (long)wake.tv_sec - (long)now.tv_sec;
  long nsec = wake.tv_nsec - now.tv_nsec;
  if (nsec < 0) {
    sec--;
    nsec += 1000000000L;
  }
  if (sec < 0) return;
  struct timespec ts;
  ts.tv_sec = sec;
  ts.tv_nsec = nsec;
  nanosleep(&ts, NULL);
#endif
}

static int capture_writers_gone(int fd, char *buf, size_t n, size_t *used) {
  for (;;) {
    char tmp[512];
    ssize_t got = read(fd, tmp, sizeof tmp);
    if (got < 0 && errno == EINTR) return 0;
    if (got < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (got <= 0) return 1;
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

static int reap_bounded(pid_t pid, int fd, int *status, int reaped) {
  kill_group(pid, reaped);
  struct timespec cleanup;
  if (mono_now(&cleanup) != 0) {
    close(fd);
    return -1;
  }
  mono_add_ms(&cleanup, 200);
  while (!reaped && !mono_reached(&cleanup)) {
    pid_t got = waitpid(pid, status, WNOHANG);
    if (got == pid) reaped = 1;
    else if (got < 0 && errno != EINTR) break;
    else {
      sleep_once(&cleanup, 20);
    }
  }
  close(fd);
  return -1;
}

/* A child that calls setsid, or a shell in monitor mode (set -m), leaves this
   process group and survives the deadline. Do not walk the descendant tree.
   A profile may have started a daemon on purpose. */
static int run_capture(char *const argv[], char *buf, size_t n, int timeout_ms) {
  if (!argv || !argv[0] || !buf || n == 0) return -1;
  int pipefd[2];
  if (pipe(pipefd) != 0) return -1;
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return -1;
  }
  if (pid == 0) {
    setpgid(0, 0);
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
  setpgid(pid, pid);
  close(pipefd[1]);
  int status = 0;
  int flags = fcntl(pipefd[0], F_GETFL, 0);
  if (flags < 0 || fcntl(pipefd[0], F_SETFL, flags | O_NONBLOCK) < 0) {
    return reap_bounded(pid, pipefd[0], &status, 0);
  }
  size_t used = 0;
  buf[0] = 0;
  int reaped = 0;
  int eof = 0;
  struct timespec deadline;
  if (mono_now(&deadline) != 0) return reap_bounded(pid, pipefd[0], &status, reaped);
  mono_add_ms(&deadline, timeout_ms);
  for (;;) {
    if (!eof && capture_writers_gone(pipefd[0], buf, n, &used)) eof = 1;
    if (!reaped) {
      pid_t got = waitpid(pid, &status, WNOHANG);
      if (got == pid) reaped = 1;
      else if (got < 0 && errno != EINTR) {
        reaped = 1;
        return reap_bounded(pid, pipefd[0], &status, reaped);
      }
    }
    if (reaped && eof) break;
    if (mono_reached(&deadline)) break;
    if (mono_left_ms(&deadline) <= 0) break;
    sleep_once(&deadline, 50);
  }
  if (reaped && eof) {
    close(pipefd[0]);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;
    return 0;
  }
  return reap_bounded(pid, pipefd[0], &status, reaped);
}

int bao_real_major(const char *path, void *ctx) {
  (void)ctx;
  if (!path || path[0] != '/') return -1;
  char *argv[] = {(char *)path, "-v", NULL};
  char buf[128];
  if (run_capture(argv, buf, sizeof buf, 2000) != 0) return -1;
  BaoVer ver;
  if (!bao_parse_version(buf, &ver) || !ver.ok) return -1;
  return ver.major;
}

int bao_real_shell(const char *shell_path, char *buf, size_t n, void *ctx) {
  (void)ctx;
  if (!shell_path || shell_path[0] != '/' || !buf || n == 0) return -1;
  char *argv[] = {(char *)shell_path, "-lc", "command -v node", NULL};
  return run_capture(argv, buf, n, 3000);
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
