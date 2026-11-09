/* Bao.app/Contents/MacOS/bao-mcp: the bao stdio MCP server for agents.
 * Claude Code and Codex start this file. It finds Node 24 or newer the way
 * Bao.app does, then becomes `node src/app/cli.js mcp [args]`, run from the
 * copy of the server inside this bundle. So an agent config names no
 * checkout and does not need node on PATH.
 *
 * Once node runs, stdout is the agent's JSON-RPC channel, so this file
 * writes only to stderr.
 *
 * Built with -DBAO_CLI it is Contents/MacOS/bao-cli instead: the same Node
 * and the same server copy, as `node src/app/cli.js [args]`. The installer
 * runs `bao-cli setup`, and ~/.local/bin/bao can link to it.
 *
 * Node starts through Contents/MacOS/bao --run-node, which picks the app macOS
 * asks before Bao reads Google Chrome's folder (bao-run-node.h). bao-cli always
 * answers as Bao, so setup and doctor see Bao's own Files & Folders switch.
 * bao-mcp answers as Bao only in a build signed with a certificate. */

#include <errno.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "bao-launch.h"

static void dirname_inplace(char *path) {
  char *slash = strrchr(path, '/');
  if (!slash) return;
  if (slash == path) {
    slash[1] = '\0';
    return;
  }
  *slash = '\0';
}

#ifdef BAO_CLI
#define LAUNCHER "bao-cli"
#define FIXED_ARGS 2
#define RUN_NODE_FLAGS 3
#else
#define LAUNCHER "bao-mcp"
#define FIXED_ARGS 3
#define RUN_NODE_FLAGS 2
#endif

static int fail(const char *what) {
  fprintf(stderr, LAUNCHER ": %s\n", what);
  return 1;
}

int main(int argc, char *argv[]) {
  char exe[4096];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0) return fail("cannot read its own path");
  char contents[4096];
  if (!realpath(exe, contents)) return fail("cannot read its own path");
  /* Contents/MacOS/bao-mcp -> Contents */
  dirname_inplace(contents);
  dirname_inplace(contents);

  char resources[4096];
  char root[4096];
  char cli[4096];
  char helper[4096];
  int wrote = snprintf(resources, sizeof resources, "%s/Resources", contents);
  if (wrote < 0 || (size_t)wrote >= sizeof resources) return fail("the app path is too long");
  snprintf(root, sizeof root, "%s/bao", resources);
  snprintf(cli, sizeof cli, "%s/src/app/cli.js", root);
  snprintf(helper, sizeof helper, "%s/BaoOSHelper.app", resources);
  if (access(cli, R_OK) != 0) {
    fprintf(stderr, LAUNCHER ": %s is missing. Install Bao again.\n", cli);
    return 1;
  }

  /* The same browser and helper the app's server gets from bao-main.c, so
   * run_workflow replays in Bao's own Chrome with the bundled browser. */
  char browser[4096];
  if (bao_find_browser(browser, sizeof browser, resources)) setenv("BAO_BROWSER", browser, 1);
  if (access(helper, F_OK) == 0) setenv("BAO_OS_HELPER", helper, 1);

  char user_home[4096];
  bao_user_home(user_home, sizeof user_home);
  BaoDiscoverHooks hooks;
  hooks.is_exec = bao_real_is_exec;
  hooks.major = bao_real_major;
  hooks.shell = bao_real_shell;
  hooks.ctx = NULL;
  char bundled[4096];
  const char *hint = bao_node_hint(getenv("BAO_NODE"), resources, bundled, sizeof bundled);
  char node[4096];
  if (bao_discover_node(hint, user_home, getenv("SHELL"), &hooks, node, sizeof node) != 0) {
    return fail("Bao needs Node.js 24 or newer. Install it with `brew install node@24`, or set BAO_NODE to its absolute path.");
  }

  /* The app's server runs from this directory too. The server finds files
   * beside it, such as ../BaoOSHelper.app, from the working directory, and
   * the agent's own directory cannot pick a .bao-mcp library. */
  if (chdir(root) != 0) {
    fprintf(stderr, LAUNCHER ": cannot enter %s: %s\n", root, strerror(errno));
    return 1;
  }

  char **args = calloc((size_t)argc + FIXED_ARGS, sizeof *args);
  if (!args) return fail("out of memory");
  args[0] = "node";
  args[1] = cli;
#ifndef BAO_CLI
  args[2] = "mcp";
#endif
  for (int i = 1; i < argc; i++) args[i + FIXED_ARGS - 1] = argv[i];
  args[argc + FIXED_ARGS - 1] = NULL;

  char app[4096];
  snprintf(app, sizeof app, "%s/MacOS/bao", contents);
  if (access(app, X_OK) == 0) {
    /* bao --run-node [--own] <node> cli.js [mcp] [args...] */
    char **run = calloc((size_t)argc + FIXED_ARGS + RUN_NODE_FLAGS, sizeof *run);
    if (!run) return fail("out of memory");
    int n = 0;
    run[n++] = "bao";
    run[n++] = "--run-node";
#ifdef BAO_CLI
    run[n++] = "--own";
#endif
    run[n++] = node;
    for (int i = 1; args[i]; i++) run[n++] = args[i];
    run[n] = NULL;
    execv(app, run);
    fprintf(stderr, LAUNCHER ": cannot start %s: %s\n", app, strerror(errno));
    return 1;
  }
  /* A bundle without its app executable, as in the launcher tests. */
  execv(node, args);
  fprintf(stderr, LAUNCHER ": cannot start %s: %s\n", node, strerror(errno));
  return 1;
}
