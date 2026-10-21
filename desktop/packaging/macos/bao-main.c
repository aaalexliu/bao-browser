/* Bao.app entry point. A real executable, not a shell script.
 * Starts the local Node server and the Chromium bundled in Resources.
 * Does not launch an installed Chrome. */

#include <mach-o/dyld.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void dirname_inplace(char *path) {
  char *slash = strrchr(path, '/');
  if (!slash) return;
  if (slash == path) {
    slash[1] = '\0';
    return;
  }
  *slash = '\0';
}

static void nap_ms(int ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, NULL);
}

int main(void) {
  char exe[4096];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0) return 1;
  char resolved[4096];
  if (!realpath(exe, resolved)) return 1;
  /* Contents/MacOS/bao -> Contents */
  dirname_inplace(resolved);
  dirname_inplace(resolved);

  char resources[4096];
  char root[4096];
  char browser[4096];
  char public_dir[4096];
  snprintf(resources, sizeof resources, "%s/Resources", resolved);
  snprintf(root, sizeof root, "%s/bao", resources);
  snprintf(browser, sizeof browser, "%s/Chromium.app/Contents/MacOS/Chromium", resources);
  snprintf(public_dir, sizeof public_dir, "%s/public", root);

  const char *home = getenv("HOME");
  if (!home || !home[0]) home = "/tmp";
  char bao_home[4096];
  const char *override = getenv("BAO_HOME");
  if (override && override[0]) snprintf(bao_home, sizeof bao_home, "%s", override);
  else snprintf(bao_home, sizeof bao_home, "%s/Library/Application Support/bao", home);

  const char *port = getenv("BAO_PORT");
  if (!port || !port[0]) port = "4787";

  pid_t node = fork();
  if (node < 0) return 1;
  if (node == 0) {
    setenv("BAO_PUBLIC", public_dir, 1);
    if (chdir(root) != 0) _exit(127);
    execlp("node", "node", "src/app/cli.js", "serve", "--home", bao_home, "--port", port, (char *)NULL);
    _exit(127);
  }

  nap_ms(400);

  char url[160];
  char profile[4096];
  snprintf(url, sizeof url, "--app=http://127.0.0.1:%s", port);
  snprintf(profile, sizeof profile, "--user-data-dir=%s/ui-profile", bao_home);

  pid_t browser_pid = fork();
  if (browser_pid == 0) {
    execl(
      browser,
      browser,
      url,
      profile,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      (char *)NULL
    );
    _exit(127);
  }

  int status = 0;
  if (browser_pid > 0) waitpid(browser_pid, &status, 0);
  kill(node, SIGTERM);
  waitpid(node, &status, 0);
  return 0;
}
