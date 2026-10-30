/* Bao.app entry point. A real executable, not a shell script.
 * Starts the local Node server and the Chromium bundled in Resources.
 * Does not launch an installed Chrome.
 *
 * Node is the one already on this Mac. A runtime copied into Resources would
 * be a second binary to sign, and codesign --deep on this bundle would change
 * the helper CDHash. See bao-launch.h. */

#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <pwd.h>
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
static const char kHomeTitle[] = "Bao needs a home directory";

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

/* Node lookup only. An empty HOME must not become /tmp for the library.
 * The passwd directory is copied because getpwuid reuses one buffer. */
static void node_lookup_home(char *out, size_t n) {
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

static int read_line(int fd, char *out, size_t n) {
  if (!out || n < 2) return -1;
  size_t i = 0;
  for (;;) {
    char ch = 0;
    ssize_t got = read(fd, &ch, 1);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) return -1;
    if (got == 0) {
      if (i == 0) return -1;
      out[i] = 0;
      return 0;
    }
    if (ch == '\n') {
      out[i] = 0;
      return 0;
    }
    if (i + 1 >= n) return -1;
    out[i++] = ch;
  }
}

static void append_text(char *out, size_t n, const char *line) {
  size_t used = strlen(out);
  size_t add = strlen(line);
  int gap = used > 0 ? 1 : 0;
  if (used + (size_t)gap + add + 1 > n) return;
  if (gap) out[used++] = '\n';
  memcpy(out + used, line, add + 1);
}

/* Runs print-home.cjs in the caller's cwd. 0 writes the home. -1 writes an error.
 * Lines after the home are messages to show now. print-home records them in the
 * library, so each one shows once. */
static int run_print_home(const char *node, const char *script, char *home, size_t home_n, char *split_body, size_t split_n, char *error, size_t error_n) {
  if (split_body && split_n) split_body[0] = '\0';
  if (error && error_n) error[0] = '\0';
  int pipefd[2];
  if (pipe(pipefd) != 0) return -1;
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return -1;
  }
  if (pid == 0) {
    if (dup2(pipefd[1], STDOUT_FILENO) < 0) _exit(127);
    int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) {
      dup2(devnull, STDERR_FILENO);
      close(devnull);
    }
    close(pipefd[0]);
    close(pipefd[1]);
    execl(node, "node", script, (char *)NULL);
    _exit(127);
  }
  close(pipefd[1]);
  char status[32];
  char line[8192];
  int failed = read_line(pipefd[0], status, sizeof status);
  if (failed == 0) failed = read_line(pipefd[0], line, sizeof line);
  if (failed == 0 && strcmp(status, "ok") == 0) {
    if (strlen(line) + 1 > home_n) failed = -1;
    else memcpy(home, line, strlen(line) + 1);
    while (failed == 0 && read_line(pipefd[0], line, sizeof line) == 0) {
      if (line[0] && split_body && split_n) append_text(split_body, split_n, line);
    }
  } else if (failed == 0 && error && error_n) {
    snprintf(error, error_n, "%s", line);
    failed = -1;
  } else {
    failed = -1;
  }
  close(pipefd[0]);
  int wait_status = 0;
  waitpid(pid, &wait_status, 0);
  return failed == 0 ? 0 : -1;
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

  char user_home[4096];
  node_lookup_home(user_home, sizeof user_home);
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

  char script[4096];
  int script_wrote = snprintf(script, sizeof script, "%s/src/print-home.cjs", root);
  char bao_home[4096];
  char split_body[8192];
  char home_error[1024];
  bao_home[0] = '\0';
  split_body[0] = '\0';
  home_error[0] = '\0';
  if (script_wrote < 0 || (size_t)script_wrote >= sizeof script ||
      run_print_home(node_bin, script, bao_home, sizeof bao_home, split_body, sizeof split_body, home_error, sizeof home_error) != 0 ||
      !bao_home[0]) {
    bao_show_alert(kHomeTitle, home_error[0] ? home_error : kOpenBody);
    return 1;
  }
  /* Right away: print-home already recorded these lines as shown. */
  if (split_body[0]) bao_show_alert(kSplitTitle, split_body);

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

  /* The capture browser stays hidden unless this is set. The documented test types into it. */
  if (!getenv("BAO_HEADED")) setenv("BAO_HEADED", "1", 0);

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
