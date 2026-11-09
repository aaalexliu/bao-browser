#include "bao-run-node.h"

#include <errno.h>
#include <libproc.h>
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

int bao_run_node(const char *self, int argc, char *argv[]) {
  int at = 0;
  int own = at < argc && strcmp(argv[at], "--own") == 0;
  int owned = at < argc && strcmp(argv[at], "--owned") == 0;
  if (own || owned) at++;
#ifdef BAO_CERT_SIGNED
  own = 1;
#endif
  if (at >= argc) {
    fprintf(stderr, "usage: bao --run-node [--own] <node> [args...]\n");
    return 2;
  }
  const char *node = argv[at];
  pid_t me = getpid();
  pid_t responsible = (pid_t)bao_note_responsible();

  if (own && !owned && responsible != me) {
    /* bao --run-node --owned <node> [args...]: --owned stops a second copy. */
    char **args = calloc((size_t)(argc - at) + 4, sizeof *args);
    if (!args) return 1;
    args[0] = "bao";
    args[1] = "--run-node";
    args[2] = "--owned";
    for (int i = at; i < argc; i++) args[3 + i - at] = argv[i];
    return spawn_and_wait(self, args, 1);
  }

  char **args = calloc((size_t)(argc - at) + 1, sizeof *args);
  if (!args) return 1;
  args[0] = "node";
  for (int i = at + 1; i < argc; i++) args[i - at] = argv[i];
  if (responsible == me) return spawn_and_wait(node, args, 0);
  execv(node, args);
  fprintf(stderr, "bao: cannot start %s: %s\n", node, strerror(errno));
  return 127;
}
