/* Bao.app entry point. A real executable, not a shell script.
 * Starts the local Node server and the Chromium bundled in Resources.
 * Does not launch an installed Chrome.
 *
 * Node is the one already on this Mac. A runtime copied into Resources would
 * be a second binary to sign, and codesign --deep on this bundle would change
 * the helper CDHash. See bao-launch.h. */

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <sys/stat.h>
#include <unistd.h>
#include "bao-launch.h"
#include "bao-notify.h"

static const char kNeedNodeTitle[] = "Bao needs Node.js";
static const char kNeedNodeBody[] =
    "Install Node.js 24 or newer, then open Bao again.\n\n"
    "https://nodejs.org\n\n"
    "Or in Terminal: brew install node@24";
static const char kOpenTitle[] = "Bao could not open";
static const char kOpenBody[] =
    "Bao could not open its window. Quit Bao from the Dock if it is already running, then open Bao again.";
static const char kAlreadyTitle[] = "Bao is already open";
static const char kAlreadyBody[] = "Switch to the Bao window.";
static const char kBrowserBody[] = "This copy of Bao is missing its browser. Install Bao again.";
static const char kSplitTitle[] = "Two libraries";

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

/* 0 and *out set when exec worked. The pipe is CLOEXEC, so a successful exec
 * closes it. A failed exec writes errno and exits. */
static int spawn_browser(const char *browser, char *const argv[], pid_t *out) {
  int pipefd[2];
  if (pipe(pipefd) != 0) return -1;
  int flags = fcntl(pipefd[1], F_GETFD);
  if (flags >= 0) fcntl(pipefd[1], F_SETFD, flags | FD_CLOEXEC);
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return -1;
  }
  if (pid == 0) {
    close(pipefd[0]);
    execv(browser, argv);
    int err = errno;
    ssize_t wrote = write(pipefd[1], &err, sizeof err);
    (void)wrote;
    _exit(127);
  }
  close(pipefd[1]);
  int err = 0;
  size_t got = 0;
  while (got < sizeof err) {
    ssize_t n = read(pipefd[0], (char *)&err + got, sizeof err - got);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    got += (size_t)n;
  }
  close(pipefd[0]);
  int status = 0;
  if (got == 0) {
    pid_t done = waitpid(pid, &status, WNOHANG);
    if (done == pid) return -1;
    *out = pid;
    return 0;
  }
  waitpid(pid, &status, 0);
  return -1;
}

static void stop_pid(pid_t pid) {
  if (pid <= 0) return;
  kill(pid, SIGTERM);
  int status = 0;
  for (int i = 0; i < 20; i++) {
    pid_t got = waitpid(pid, &status, WNOHANG);
    if (got == pid || (got < 0 && errno != EINTR)) return;
    nap_ms(50);
  }
  kill(pid, SIGKILL);
  waitpid(pid, &status, 0);
}

static int path_ok(int wrote, size_t cap) {
  return wrote >= 0 && (size_t)wrote < cap;
}

/* Expand a leading ~/ and make the path absolute against the launch directory. */
static int expand_abs(char *out, size_t n, const char *raw, const char *user_home) {
  char expanded[4096];
  const char *src = raw;
  if (raw[0] == '~' && (raw[1] == '\0' || raw[1] == '/')) {
    int wrote = snprintf(expanded, sizeof expanded, "%s%s", user_home, raw + 1);
    if (!path_ok(wrote, sizeof expanded)) return -1;
    src = expanded;
  }
  if (src[0] == '/') {
    int wrote = snprintf(out, n, "%s", src);
    return path_ok(wrote, n) ? 0 : -1;
  }
  char cwd[4096];
  if (!getcwd(cwd, sizeof cwd)) return -1;
  int wrote = snprintf(out, n, "%s/%s", cwd, src);
  return path_ok(wrote, n) ? 0 : -1;
}

static int has_workflows(const char *dir) {
  char folder[4096];
  int wrote = snprintf(folder, sizeof folder, "%s/workflows", dir);
  if (!path_ok(wrote, sizeof folder)) return 0;
  DIR *handle = opendir(folder);
  if (!handle) return 0;
  int found = 0;
  struct dirent *ent;
  while ((ent = readdir(handle)) != NULL) {
    const char *name = ent->d_name;
    size_t len = strlen(name);
    if (len < 6 || strcmp(name + len - 5, ".json") != 0) continue;
    char file[8192];
    int n = snprintf(file, sizeof file, "%s/%s", folder, name);
    if (!path_ok(n, sizeof file)) continue;
    struct stat st;
    if (stat(file, &st) == 0 && S_ISREG(st.st_mode)) {
      found = 1;
      break;
    }
  }
  closedir(handle);
  return found;
}

/* Pick the library before mkdir and before the child chdir. split_body is the
 * same sentence the window shows when two directories both hold workflows. */
static int resolve_bao_home(char *bao_home, size_t n, const char *user_home, char *split_body, size_t split_n) {
  if (split_body && split_n) split_body[0] = '\0';
  const char *override = getenv("BAO_HOME");
  char requested[4096];
  if (override && override[0]) {
    int wrote = snprintf(requested, sizeof requested, "%s", override);
    if (!path_ok(wrote, sizeof requested)) return -1;
  } else {
    int wrote = snprintf(requested, sizeof requested, "%s/Library/Application Support/bao", user_home);
    if (!path_ok(wrote, sizeof requested)) return -1;
  }
  if (expand_abs(bao_home, n, requested, user_home) != 0) return -1;

  char legacy_local[4096];
  char legacy_mcp[4096];
  int local_wrote = snprintf(legacy_local, sizeof legacy_local, "%s/.local/share/bao", user_home);
  if (!path_ok(local_wrote, sizeof legacy_local)) return -1;
  char cwd[4096];
  int mcp_ok = 0;
  if (getcwd(cwd, sizeof cwd)) {
    int mcp_wrote = snprintf(legacy_mcp, sizeof legacy_mcp, "%s/.bao-mcp", cwd);
    mcp_ok = path_ok(mcp_wrote, sizeof legacy_mcp);
  }
  int chosen_has = has_workflows(bao_home);
  int local_has = strcmp(legacy_local, bao_home) != 0 && has_workflows(legacy_local);
  int mcp_has = mcp_ok && strcmp(legacy_mcp, bao_home) != 0 && has_workflows(legacy_mcp);
  if (!chosen_has && (local_has || mcp_has)) {
    const char *keep = local_has ? legacy_local : legacy_mcp;
    int wrote = snprintf(bao_home, n, "%s", keep);
    if (!path_ok(wrote, n)) return -1;
    if (local_has && mcp_has && split_body && split_n) {
      int body = snprintf(split_body, split_n, "library data is at %s; using %s", legacy_mcp, bao_home);
      if (!path_ok(body, split_n)) split_body[0] = '\0';
    }
    return 0;
  }
  if (!chosen_has || !split_body || !split_n) return 0;
  if (local_has && mcp_has) {
    int body = snprintf(split_body, split_n, "library data is at %s; using %s\nlibrary data is at %s; using %s", legacy_local, bao_home, legacy_mcp, bao_home);
    if (!path_ok(body, split_n)) split_body[0] = '\0';
  } else if (local_has || mcp_has) {
    const char *other = local_has ? legacy_local : legacy_mcp;
    int body = snprintf(split_body, split_n, "library data is at %s; using %s", other, bao_home);
    if (!path_ok(body, split_n)) split_body[0] = '\0';
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
    bao_show_alert(kOpenTitle, kBrowserBody);
    return 1;
  }
  /* Fallback when Google Chrome is not installed. The launcher prefers Chrome. */
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

  const char *user_home = getenv("HOME");
  if (!user_home || !user_home[0]) user_home = "/tmp";
  char bao_home[4096];
  char split_body[8192];
  split_body[0] = '\0';
  if (resolve_bao_home(bao_home, sizeof bao_home, user_home, split_body, sizeof split_body) != 0) {
    bao_show_alert(kOpenTitle, kOpenBody);
    return 1;
  }

  const char *port = getenv("BAO_PORT");
  if (!port || !port[0]) port = "4787";
  mkdir(bao_home, 0700);
  char notify_sock[4096];
  snprintf(notify_sock, sizeof notify_sock, "%s/notify.sock", bao_home);

  int other = -1;
  int inst = bao_instance_acquire(bao_home, &other);
  if (inst < 0) {
    bao_show_alert(kOpenTitle, kOpenBody);
    return 1;
  }
  if (inst == 1) {
    for (int i = 0; i < 80 && inst == 1; i++) {
      int pid = bao_read_browser_pid(bao_home);
      if (pid > 0) {
        bao_focus_pid(pid);
        return 0;
      }
      nap_ms(100);
      inst = bao_instance_acquire(bao_home, &other);
      if (inst < 0) {
        bao_show_alert(kOpenTitle, kOpenBody);
        return 1;
      }
    }
    if (inst != 0) {
      bao_show_alert(kAlreadyTitle, kAlreadyBody);
      return 0;
    }
  }

  if (bao_port_listening(port)) {
    bao_show_alert(kAlreadyTitle, kAlreadyBody);
    return 0;
  }

  if (bao_notify_prepare(notify_sock) == 0) setenv("BAO_NOTIFY_SOCK", notify_sock, 1);
  else fprintf(stderr, "bao notify socket was not created\n");

  char node_bin[4096];
  BaoDiscoverHooks hooks;
  hooks.is_exec = bao_real_is_exec;
  hooks.major = bao_real_major;
  hooks.shell = bao_real_shell;
  hooks.ctx = NULL;
  if (bao_discover_node(getenv("BAO_NODE"), user_home, getenv("SHELL"), &hooks, node_bin, sizeof node_bin) != 0) {
    bao_show_alert(kNeedNodeTitle, kNeedNodeBody);
    return 1;
  }
  /* The capture browser stays hidden unless this is set. The documented test types into it. */
  if (!getenv("BAO_HEADED")) setenv("BAO_HEADED", "1", 0);
  if (split_body[0]) bao_show_alert(kSplitTitle, split_body);

  pid_t node = fork();
  if (node < 0) {
    bao_show_alert(kOpenTitle, kOpenBody);
    return 1;
  }

  if (node == 0) {
    setenv("BAO_HOME", bao_home, 1);
    setenv("BAO_PUBLIC", public_dir, 1);
    if (chdir(root) != 0) _exit(127);
    execl(node_bin, "node", "src/app/cli.js", "serve", "--home", bao_home, "--port", port, (char *)NULL);
    _exit(127);
  }

  /* Open the window only after the server accepts a connection, so Chromium
   * never paints its offline page (that page shows the listen address). */
  if (bao_wait_for_port(port, (int)node, 15000) != 0) {
    stop_pid(node);
    bao_show_alert(kOpenTitle, kOpenBody);
    return 1;
  }

  char url[160];
  char profile[4096];
  int url_wrote = snprintf(url, sizeof url, "--app=http://127.0.0.1:%s/", port);
  int profile_wrote = snprintf(profile, sizeof profile, "--user-data-dir=%s/ui-profile", bao_home);
  if (url_wrote < 0 || (size_t)url_wrote >= sizeof url || profile_wrote < 0 || (size_t)profile_wrote >= sizeof profile) {
    stop_pid(node);
    bao_show_alert(kOpenTitle, kOpenBody);
    return 1;
  }

  char *browser_argv[] = {
    browser,
    url,
    profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--force-renderer-accessibility",
    /* App mode hides the toolbar. This switch hides the Chrome for Testing infobar. */
    "--disable-infobars",
    NULL,
  };
  pid_t browser_pid = -1;
  if (spawn_browser(browser, browser_argv, &browser_pid) != 0) {
    stop_pid(node);
    bao_show_alert(kOpenTitle, kOpenBody);
    return 1;
  }
  bao_instance_write_browser_pid(bao_home, (int)browser_pid);
  return bao_notify_run((int)browser_pid, (int)node);
}
