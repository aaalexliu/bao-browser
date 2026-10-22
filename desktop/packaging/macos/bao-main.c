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
#include <sys/stat.h>
#include <unistd.h>
#include "bao-notify.h"

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

/* Playwright's mac download is "Google Chrome for Testing.app". The bundle
 * is copied to Chromium.app, and the inner executable keeps that name. */
static int find_browser(char *out, size_t n, const char *resources) {
  char dir[4096];
  const char *names[] = {"Chromium", "Google Chrome for Testing", "chrome"};
  snprintf(dir, sizeof dir, "%s/Chromium.app/Contents/MacOS", resources);
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    snprintf(out, n, "%s/%s", dir, names[i]);
    if (access(out, X_OK) == 0) return 1;
  }
  return 0;
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
  snprintf(public_dir, sizeof public_dir, "%s/public", root);
  if (!find_browser(browser, sizeof browser, resources)) {
    fprintf(stderr, "bao: bundled browser executable was not found under Resources/Chromium.app\n");
    return 1;
  }
  /* Capture and replay use this binary too, not an installed Chrome. */
  setenv("BAO_BROWSER", browser, 1);
  /* v1 launches the helper inside this app, not a second copy on disk. */
  char helper[4096];
  snprintf(helper, sizeof helper, "%s/BaoOSHelper.app", resources);
  if (access(helper, F_OK) == 0) setenv("BAO_OS_HELPER", helper, 1);
  char bar[4096];
  snprintf(bar, sizeof bar, "%s/BaoCaptureBar.app/Contents/MacOS/BaoCaptureBar", resources);
  if (access(bar, X_OK) == 0) {
    setenv("BAO_CAPTURE_BAR", "1", 1);
    setenv("BAO_CAPTURE_BAR_BIN", bar, 1);
  }

  const char *home = getenv("HOME");
  if (!home || !home[0]) home = "/tmp";
  char bao_home[4096];
  const char *override = getenv("BAO_HOME");
  if (override && override[0]) snprintf(bao_home, sizeof bao_home, "%s", override);
  else snprintf(bao_home, sizeof bao_home, "%s/Library/Application Support/bao", home);

  const char *port = getenv("BAO_PORT");
  if (!port || !port[0]) port = "4787";
  mkdir(bao_home, 0700);
  char notify_sock[4096];
  snprintf(notify_sock, sizeof notify_sock, "%s/notify.sock", bao_home);
  if (bao_notify_prepare(notify_sock) == 0) setenv("BAO_NOTIFY_SOCK", notify_sock, 1);
  else fprintf(stderr, "bao notify socket was not created\n");
  /* A Finder launch does not inherit the shell PATH. BAO_NODE is an absolute node. */
  const char *node_bin = getenv("BAO_NODE");
  if (!node_bin || !node_bin[0]) node_bin = "node";
  /* The capture browser stays hidden unless this is set. The documented test types into it. */
  if (!getenv("BAO_HEADED")) setenv("BAO_HEADED", "1", 0);

  pid_t node = fork();
  if (node < 0) return 1;
  if (node == 0) {
    setenv("BAO_PUBLIC", public_dir, 1);
    if (chdir(root) != 0) _exit(127);
    execlp(node_bin, "node", "src/app/cli.js", "serve", "--home", bao_home, "--port", port, (char *)NULL);
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
      "--force-renderer-accessibility",
      /* App mode hides the toolbar. This switch hides the Chrome for Testing infobar. */
      "--disable-infobars",
      (char *)NULL
    );
    _exit(127);
  }

  return bao_notify_run((int)browser_pid, (int)node);
}
