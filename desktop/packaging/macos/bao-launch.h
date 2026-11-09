#ifndef BAO_LAUNCH_H
#define BAO_LAUNCH_H

#include <stddef.h>

/* Finder does not pass a shell PATH. Node 24+ is chosen from BAO_NODE, then
 * the Node bundled at Resources/node/bin/node when the build has one, then
 * Homebrew (including the keg-only node@24 prefix), /usr/local, mise, nvm,
 * and volta, then one login-shell lookup.
 * A bundled Node keeps its own nodejs.org signature. package-app.sh never
 * signs with --deep, which would replace the helper CDHash and drop the grant. */

typedef struct BaoVer {
  int major;
  int minor;
  int patch;
  int ok;
} BaoVer;

typedef struct BaoDiscoverHooks {
  /* 1 when path is an executable file. */
  int (*is_exec)(const char *path, void *ctx);
  /* Major version, or -1 when the binary cannot run. */
  int (*major)(const char *path, void *ctx);
  /* Runs `$SHELL -lc 'command -v node'` once. 0 and writes stdout on success. */
  int (*shell)(const char *shell_path, char *buf, size_t n, void *ctx);
  void *ctx;
} BaoDiscoverHooks;

int bao_parse_version(const char *text, BaoVer *out);
int bao_version_cmp(BaoVer a, BaoVer b);

/* Copies one absolute path. Rejects an alias, a function, and a relative name. */
int bao_accept_shell_output(const char *text, char *out, size_t n);

/* Shell to ask once. Prefers SHELL, then /bin/zsh, then /bin/bash. */
const char *bao_login_shell(const char *env_shell, int (*is_exec)(const char *path, void *ctx), void *ctx);

/* The first Node to try: BAO_NODE when it is set, else Resources/node/bin/node
 * when that file is executable, else NULL. bao_discover_node still checks the
 * version and falls back to the system lookup. */
const char *bao_node_hint(const char *env_node, const char *resources, char *buf, size_t n);

/* 0 and an absolute Node 24+ path in out. -1 when nothing qualifies. */
int bao_discover_node(const char *bao_node, const char *home, const char *env_shell,
                      const BaoDiscoverHooks *hooks, char *out, size_t out_n);

/* bao_discover_node for this process, from bao_node_hint. BAO_NODE counts only
 * with allow_env: Bao's Files & Folders grant must not run a Node the caller
 * named, so a process that answers to macOS as Bao passes 0. */
int bao_pick_node(const char *resources, int allow_env, char *out, size_t n);

/* HOME when it is absolute, else the passwd entry's directory, else empty.
 * Only for the Node lookup: an empty HOME must not become /tmp for the library. */
void bao_user_home(char *out, size_t n);

/* 1 and the browser path in out when Resources/Chromium.app has one, else 0.
 * Playwright's mac download is "Google Chrome for Testing.app". package-app.sh
 * copies it to Chromium.app, and the inner executable keeps that name. */
int bao_find_browser(char *out, size_t n, const char *resources);

int bao_real_is_exec(const char *path, void *ctx);
int bao_real_major(const char *path, void *ctx);
int bao_real_shell(const char *shell_path, char *buf, size_t n, void *ctx);

/* Runs argv in its own process group with stdout in buf. 0 when it exits 0
 * and every writer closes stdout inside timeout_ms, else -1. When the deadline
 * passes or a writer outlives the child, it first kills the group and every
 * process that still holds the pipe. */
int bao_run_capture(char *const argv[], char *buf, size_t n, int timeout_ms);

/* 0 when this process owns the instance. 1 when another live process does,
 * and *other_pid is that window's pid or -1. -1 on error. */
int bao_instance_acquire(const char *home, int *other_pid);
void bao_instance_release(void);
int bao_instance_write_ui_pid(const char *home, int pid);
int bao_read_ui_pid(const char *home);

int bao_port_listening(const char *port);
int bao_recover_server(const char *node, const char *root, const char *home, const char *port);
/* 0 when the port accepts a connection. -1 on timeout or if child_pid has exited. */
int bao_wait_for_port(const char *port, int child_pid, int timeout_ms);

#endif
