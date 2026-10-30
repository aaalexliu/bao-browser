/* Bao.app/Contents/MacOS/bao-mcp: the bao stdio MCP server for agents.
 * Claude Code and Codex start this file. It finds Node 24 or newer the way
 * Bao.app does, then becomes `node src/app/cli.js mcp [args]`, run from the
 * copy of the server inside this bundle. So an agent config names no
 * checkout and does not need node on PATH.
 *
 * Once node runs, stdout is the agent's JSON-RPC channel, so this file
 * writes only to stderr. */

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

static int fail(const char *what) {
  fprintf(stderr, "bao-mcp: %s\n", what);
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
    fprintf(stderr, "bao-mcp: %s is missing. Install Bao again.\n", cli);
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
  char node[4096];
  if (bao_discover_node(getenv("BAO_NODE"), user_home, getenv("SHELL"), &hooks, node, sizeof node) != 0) {
    return fail("Bao needs Node.js 24 or newer. Install it with `brew install node@24`, or set BAO_NODE to its absolute path.");
  }

  /* The app's server runs from this directory too. The server finds files
   * beside it, such as ../BaoOSHelper.app, from the working directory, and
   * the agent's own directory cannot pick a .bao-mcp library. */
  if (chdir(root) != 0) {
    fprintf(stderr, "bao-mcp: cannot enter %s: %s\n", root, strerror(errno));
    return 1;
  }

  char **args = calloc((size_t)argc + 3, sizeof *args);
  if (!args) return fail("out of memory");
  args[0] = "node";
  args[1] = cli;
  args[2] = "mcp";
  for (int i = 1; i < argc; i++) args[i + 2] = argv[i];
  args[argc + 2] = NULL;
  execv(node, args);
  fprintf(stderr, "bao-mcp: cannot start %s: %s\n", node, strerror(errno));
  return 1;
}
