#ifndef BAO_LAUNCH_H
#define BAO_LAUNCH_H

#include <stddef.h>

/* Finder does not pass a shell PATH. Node 24+ is chosen from BAO_NODE, then
 * Homebrew (including the keg-only node@24 prefix), /usr/local, mise, nvm,
 * and volta, then one login-shell lookup.
 * A copy of Node inside the app is not shipped: signing that bundle with
 * --deep would replace the helper CDHash and drop the TCC grant. */

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

/* 0 and an absolute Node 24+ path in out. -1 when nothing qualifies. */
int bao_discover_node(const char *bao_node, const char *home, const char *env_shell,
                      const BaoDiscoverHooks *hooks, char *out, size_t out_n);

int bao_real_is_exec(const char *path, void *ctx);
int bao_real_major(const char *path, void *ctx);
int bao_real_shell(const char *shell_path, char *buf, size_t n, void *ctx);

/* 0 when this process owns the instance. 1 when another live process does,
 * and *other_pid is that window's pid or -1. -1 on error. */
int bao_instance_acquire(const char *home, int *other_pid);
void bao_instance_release(void);
int bao_instance_write_browser_pid(const char *home, int pid);
int bao_read_browser_pid(const char *home);

int bao_port_listening(const char *port);
/* 0 when the port accepts a connection. -1 on timeout or if child_pid has exited. */
int bao_wait_for_port(const char *port, int child_pid, int timeout_ms);

#endif
