/* posix_spawn a Bao-owned Chrome with responsibility disclaimed, print its pid, and wait.
 * Node cannot set the disclaim attribute. Chrome cannot respawn itself, so this waiter does it.
 * The child's stdout goes to /dev/null so it cannot mix with the pid line or fill the pipe.
 * Its stderr stays inherited: that is the DevTools line. Signals sent to this waiter go on to the child.
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);

static const int kForwarded[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT };
#define FORWARDED (sizeof kForwarded / sizeof kForwarded[0])

static volatile sig_atomic_t child_pid = 0;

static void forward(int sig) {
  if (child_pid > 0) kill((pid_t)child_pid, sig);
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "bao-spawn: missing executable\n");
    return 64;
  }

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
  if (posix_spawnattr_init(&attr) != 0) return 127;
  sigset_t none;
  sigemptyset(&none);
  posix_spawnattr_setsigmask(&attr, &none);
  posix_spawnattr_setsigdefault(&attr, &block);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  int disclaimed = responsibility_spawnattrs_setdisclaim(&attr, 1);

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);

  pid_t pid = 0;
  int spawned = disclaimed == 0 ? posix_spawn(&pid, argv[1], &actions, &attr, argv + 1, environ) : disclaimed;
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  if (disclaimed != 0 || spawned != 0) {
    sigprocmask(SIG_SETMASK, &saved, NULL);
    fprintf(stderr, "bao-spawn: spawn failed disclaim=%d spawn=%d: %s\n", disclaimed, spawned, strerror(spawned != 0 ? spawned : disclaimed));
    return 127;
  }
  child_pid = pid;
  sigprocmask(SIG_SETMASK, &saved, NULL);
  pid_t responsible = responsibility_get_pid_responsible_for_pid(pid);
  printf("%d %d\n", pid, responsible);
  fflush(stdout);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
