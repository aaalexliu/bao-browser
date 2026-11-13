#include "bao-permissions.h"
#include "bao-run-node.h"
#include "bao-launch.h"

#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

/* libSystem, macOS 10.14 and later. Chromium and LLDB use them the same way. */
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

static const int kForwarded[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT };
#define FORWARDED (sizeof kForwarded / sizeof kForwarded[0])

static volatile sig_atomic_t child_pid = 0;

static void forward(int sig) {
  if (child_pid > 0) kill((pid_t)child_pid, sig);
}

/* Runs path as a child with this process's stdio. Signals an agent host sends
 * this process go on to the child. Returns the child's exit code, or dies of
 * the signal that killed it. */
static int spawn_and_wait(const char *path, char *const argv[], int disclaim) {
  sigset_t block, saved;
  sigemptyset(&block);
  for (size_t i = 0; i < FORWARDED; i++) sigaddset(&block, kForwarded[i]);
  sigprocmask(SIG_BLOCK, &block, &saved);
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  for (size_t i = 0; i < FORWARDED; i++) sigaction(kForwarded[i], &action, NULL);

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  sigset_t none;
  sigemptyset(&none);
  posix_spawnattr_setsigmask(&attr, &none);
  posix_spawnattr_setsigdefault(&attr, &block);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  int err = disclaim ? responsibility_spawnattrs_setdisclaim(&attr, 1) : 0;
  pid_t pid = 0;
  if (err == 0) err = posix_spawn(&pid, path, NULL, &attr, argv, environ);
  posix_spawnattr_destroy(&attr);
  if (err != 0) {
    sigprocmask(SIG_SETMASK, &saved, NULL);
    fprintf(stderr, "bao: cannot start %s: %s\n", path, strerror(err));
    return 127;
  }
  child_pid = pid;
  sigprocmask(SIG_SETMASK, &saved, NULL);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    kill(getpid(), sig);
    return 128 + sig;
  }
  return 1;
}

static int resources_of(const char *self, char *out, size_t n);

static int app_executable(const char *app, char *out, size_t n) {
  const char *base = strrchr(app, '/');
  base = base ? base + 1 : app;
  size_t len = strlen(base);
  if (len < 5 || strcmp(base + len - 4, ".app") != 0 || len - 4 >= 256) return -1;
  char name[256];
  memcpy(name, base, len - 4);
  name[len - 4] = '\0';
  int wrote = snprintf(out, n, "%s/Contents/MacOS/%s", app, name);
  return wrote < 0 || (size_t)wrote >= n ? -1 : 0;
}

static int bundled_helper_exe(const char *self, char *out, size_t n) {
  char resources[4096];
  char app[4096];
  if (resources_of(self, resources, sizeof resources) != 0) return -1;
  if (snprintf(app, sizeof app, "%s/BaoOSHelper.app", resources) >= (int)sizeof app) return -1;
  return app_executable(app, out, n);
}

int bao_run_helper(const char *self, int argc, char *argv[]) {
  int i = 2;
  int owned = i < argc && strcmp(argv[i], "--owned") == 0;
  if (owned) i++;
  if (i < argc && strcmp(argv[i], "--") != 0) {
    fprintf(stderr, "bao: --run-helper starts only Bao's own BaoOSHelper.app\n");
    return 2;
  }
  if (i < argc && strcmp(argv[i], "--") == 0) i++;
  char exe[4096];
  if (bundled_helper_exe(self, exe, sizeof exe) != 0 || access(exe, X_OK) != 0) {
    fprintf(stderr, "helper executable missing\n");
    return 1;
  }
  if (!owned) {
    char *args[64];
    int n = 0;
    args[n++] = (char *)self;
    args[n++] = "--run-helper";
    args[n++] = "--owned";
    args[n++] = "--";
    for (; i < argc && n < 63; i++) args[n++] = argv[i];
    args[n] = NULL;
    return spawn_and_wait(self, args, 1);
  }
  setenv("BAO_HELPER_INHERIT", "1", 1);
  char *args[64];
  int n = 0;
  args[n++] = exe;
  for (; i < argc && n < 63; i++) args[n++] = argv[i];
  args[n] = NULL;
  return spawn_and_wait(exe, args, 0);
}

int bao_permissions_main(const char *self, int argc, char *argv[]) {
  int owned = 0;
  for (int i = 2; i < argc; i++) if (strcmp(argv[i], "--owned") == 0) owned = 1;
  if (!owned) {
    char *args[64];
    int n = 0;
    args[n++] = (char *)self;
    args[n++] = "--permissions";
    args[n++] = "--owned";
    for (int i = 2; i < argc && n < 63; i++) {
      if (strcmp(argv[i], "--owned") == 0) continue;
      args[n++] = argv[i];
    }
    args[n] = NULL;
    return spawn_and_wait(self, args, 1);
  }
  BaoPermissionsOpts opts = {0, 0, 0, 0, NULL};
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--check") == 0) opts.check = 1;
    else if (strcmp(argv[i], "--seam") == 0 && i + 1 < argc) {
      opts.seam = strcmp(argv[++i], "allowed") == 0 ? 2 : 1;
    } else if (strcmp(argv[i], "--dock") == 0 && i + 1 < argc) {
      opts.dock = strcmp(argv[++i], "chrome") == 0 ? 2 : 1;
    } else if (strcmp(argv[i], "--appearance") == 0 && i + 1 < argc) {
      opts.appearance = strcmp(argv[++i], "dark") == 0 ? 2 : 1;
    } else if (strcmp(argv[i], "--shot") == 0 && i + 1 < argc) {
      opts.shot = argv[++i];
    }
  }
  return bao_permissions_show(&opts);
}

int bao_note_responsible(void) {
  pid_t responsible = responsibility_get_pid_responsible_for_pid(getpid());
  char exe[PROC_PIDPATHINFO_MAXSIZE];
  if (responsible > 0 && proc_pidpath(responsible, exe, sizeof exe) > 0) setenv("BAO_RESPONSIBLE_EXE", exe, 1);
  else unsetenv("BAO_RESPONSIBLE_EXE");
#ifdef BAO_CERT_SIGNED
  setenv("BAO_CERT_SIGNED", "1", 1);
#else
  unsetenv("BAO_CERT_SIGNED");
#endif
  return (int)responsible;
}

/* Contents/MacOS/bao -> Contents/Resources */
static int resources_of(const char *self, char *out, size_t n) {
  char contents[4096];
  if (snprintf(contents, sizeof contents, "%s", self) >= (int)sizeof contents) return -1;
  for (int i = 0; i < 2; i++) {
    char *slash = strrchr(contents, '/');
    if (!slash || slash == contents) return -1;
    *slash = '\0';
  }
  int wrote = snprintf(out, n, "%s/Resources", contents);
  return wrote < 0 || (size_t)wrote >= n ? -1 : 0;
}

int bao_run_node(const char *self, int argc, char *argv[]) {
  int at = 0;
  int own = at < argc && strcmp(argv[at], "--own") == 0;
  int owned = at < argc && strcmp(argv[at], "--owned") == 0;
  if (own || owned) at++;
#ifdef BAO_CERT_SIGNED
  own = 1;
#endif
  if (at >= argc) {
    fprintf(stderr, "usage: bao --run-node [--own] <Bao.app/Contents/Resources/bao/src/app/cli.js> [args...]\n");
    return 2;
  }
  char resources[4096];
  char want[4096];
  char cli[PATH_MAX];
  char got[PATH_MAX];
  if (resources_of(self, resources, sizeof resources) != 0 ||
      snprintf(want, sizeof want, "%s/bao/src/app/cli.js", resources) >= (int)sizeof want ||
      !realpath(want, cli)) {
    fprintf(stderr, "bao: cannot find Bao's own src/app/cli.js. Install Bao again.\n");
    return 1;
  }
  if (!realpath(argv[at], got) || strcmp(got, cli) != 0) {
    fprintf(stderr, "bao: --run-node runs only %s, not %s\n", cli, argv[at]);
    return 2;
  }
  pid_t me = getpid();
  pid_t responsible = (pid_t)bao_note_responsible();

  if (own && !owned && responsible != me) {
    /* bao --run-node --owned <cli.js> [args...]: --owned stops a second copy. */
    char **args = calloc((size_t)(argc - at) + 4, sizeof *args);
    if (!args) return 1;
    args[0] = "bao";
    args[1] = "--run-node";
    args[2] = "--owned";
    for (int i = at; i < argc; i++) args[3 + i - at] = argv[i];
    return spawn_and_wait(self, args, 1);
  }

  char node[4096];
  if (bao_pick_node(resources, responsible != me, node, sizeof node) != 0) {
    fprintf(stderr, "bao: Bao needs Node.js 24 or newer. Install it with `brew install node@24`.\n");
    return 1;
  }
  char **args = calloc((size_t)(argc - at) + 2, sizeof *args);
  if (!args) return 1;
  args[0] = "node";
  args[1] = cli;
  for (int i = at + 1; i < argc; i++) args[i - at + 1] = argv[i];
  if (responsible == me) return spawn_and_wait(node, args, 0);
  execv(node, args);
  fprintf(stderr, "bao: cannot start %s: %s\n", node, strerror(errno));
  return 127;
}
