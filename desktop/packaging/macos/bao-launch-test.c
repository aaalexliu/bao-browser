#define _POSIX_C_SOURCE 200809L

#include "bao-launch.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int checks;
static int failed;

static void check(int cond, const char *msg) {
  checks++;
  if (cond) return;
  fprintf(stderr, "fail %s\n", msg);
  failed++;
}

static long elapsed_ms(struct timespec start) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (now.tv_sec - start.tv_sec) * 1000L + (now.tv_nsec - start.tv_nsec) / 1000000L;
}

static void mkdir_p(const char *path) {
  char buf[4096];
  snprintf(buf, sizeof buf, "%s", path);
  for (char *p = buf + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    mkdir(buf, 0755);
    *p = '/';
  }
  mkdir(buf, 0755);
}

static void touch_x(const char *path) {
  char dir[4096];
  snprintf(dir, sizeof dir, "%s", path);
  char *slash = strrchr(dir, '/');
  if (slash) {
    *slash = 0;
    mkdir_p(dir);
  }
  int fd = open(path, O_CREAT | O_WRONLY, 0755);
  if (fd >= 0) close(fd);
  chmod(path, 0755);
}

static void write_script(const char *path, const char *body) {
  char dir[4096];
  snprintf(dir, sizeof dir, "%s", path);
  char *slash = strrchr(dir, '/');
  if (slash) {
    *slash = 0;
    mkdir_p(dir);
  }
  FILE *file = fopen(path, "w");
  if (!file) return;
  fputs(body, file);
  fclose(file);
  chmod(path, 0755);
}

static void rm_rf(const char *path) {
  struct stat st;
  if (lstat(path, &st) != 0) return;
  if (!S_ISDIR(st.st_mode)) {
    unlink(path);
    return;
  }
  DIR *dir = opendir(path);
  if (dir) {
    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL) {
      if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
      char child[4096];
      snprintf(child, sizeof child, "%s/%s", path, ent->d_name);
      rm_rf(child);
    }
    closedir(dir);
  }
  rmdir(path);
}

typedef struct World {
  const char *paths[24];
  int majors[24];
  int n;
  int shell_calls;
  const char *shell_text;
  int shell_rc;
} World;

static int world_major_from_path(const char *path) {
  const char *mark = strstr(path, "/bin/node");
  if (!mark || mark == path) return -1;
  const char *slash = mark;
  while (slash > path && slash[-1] != '/') slash--;
  char tmp[64];
  size_t len = (size_t)(mark - slash);
  if (len == 0 || len >= sizeof tmp) return -1;
  memcpy(tmp, slash, len);
  tmp[len] = 0;
  BaoVer ver;
  if (!bao_parse_version(tmp, &ver)) return -1;
  return ver.major;
}

static int world_exec(const char *path, void *ctx) {
  World *world = ctx;
  if (strcmp(path, "/bin/zsh") == 0 || strcmp(path, "/bin/bash") == 0) return 1;
  for (int i = 0; i < world->n; i++) {
    if (strcmp(world->paths[i], path) == 0) return 1;
  }
  return bao_real_is_exec(path, NULL);
}

static int world_major(const char *path, void *ctx) {
  World *world = ctx;
  for (int i = 0; i < world->n; i++) {
    if (strcmp(world->paths[i], path) == 0) return world->majors[i];
  }
  return world_major_from_path(path);
}

static int world_shell(const char *shell, char *buf, size_t n, void *ctx) {
  World *world = ctx;
  (void)shell;
  world->shell_calls++;
  if (world->shell_rc != 0) return -1;
  snprintf(buf, n, "%s", world->shell_text ? world->shell_text : "");
  return 0;
}

static void add_override(World *world, const char *path, int major) {
  world->paths[world->n] = path;
  world->majors[world->n] = major;
  world->n++;
}

static int discover(World *world, const char *bao_node, const char *home, char *out, size_t n) {
  BaoDiscoverHooks hooks = {world_exec, world_major, world_shell, world};
  return bao_discover_node(bao_node, home, NULL, &hooks, out, n);
}

static void test_versions(void) {
  BaoVer a, b;
  check(bao_parse_version("v24.11.0", &a) == 1, "parse v24.11.0");
  check(a.major == 24 && a.minor == 11 && a.patch == 0, "v24.11.0 fields");
  check(bao_parse_version("24.2.0\n", &b) == 1, "parse 24.2.0");
  check(bao_version_cmp(a, b) > 0, "24.11 is newer than 24.2");
  check(bao_parse_version("v22.14.0", &b) == 1 && b.major == 22, "parse v22");
  check(bao_parse_version("not-node", &b) == 0, "reject garbage");
  check(bao_parse_version("v24", &b) == 1 && b.major == 24 && b.minor == 0, "major only");
  BaoVer c;
  check(bao_parse_version("v24.11.0", &c) == 1 && bao_version_cmp(a, c) == 0, "same version");
}

static void test_shell_output(void) {
  char out[256];
  check(bao_accept_shell_output("/opt/homebrew/bin/node\n", out, sizeof out) == 1, "accept path");
  check(strcmp(out, "/opt/homebrew/bin/node") == 0, "trimmed path");
  check(bao_accept_shell_output("welcome\n/usr/local/bin/node\n", out, sizeof out) == 1, "last path");
  check(strcmp(out, "/usr/local/bin/node") == 0, "profile noise ignored");
  check(bao_accept_shell_output("alias node='node --experimental'\n", out, sizeof out) == 0, "reject alias");
  check(bao_accept_shell_output("alias node='/opt/homebrew/bin/node'\n/opt/homebrew/bin/node\n", out, sizeof out) == 0, "alias blocks a path");
  check(bao_accept_shell_output("node\n", out, sizeof out) == 0, "reject relative");
  check(bao_accept_shell_output("", out, sizeof out) == 0, "reject empty");
  check(bao_accept_shell_output("/usr/local/bin/node --use-system-ca\n", out, sizeof out) == 0, "reject arguments");
}

static void test_discover(const char *home) {
  char node24[512], node242[512], node22[512], nvm24[512], nvm22[512], volta24[512], volta20[512];
  snprintf(node24, sizeof node24, "%s/.local/share/mise/installs/node/24.11.0/bin/node", home);
  snprintf(node242, sizeof node242, "%s/.local/share/mise/installs/node/24.2.0/bin/node", home);
  snprintf(node22, sizeof node22, "%s/.local/share/mise/installs/node/22.14.0/bin/node", home);
  snprintf(nvm24, sizeof nvm24, "%s/.nvm/versions/node/v24.11.0/bin/node", home);
  snprintf(nvm22, sizeof nvm22, "%s/.nvm/versions/node/v22.0.0/bin/node", home);
  snprintf(volta24, sizeof volta24, "%s/.volta/tools/image/node/24.4.0/bin/node", home);
  snprintf(volta20, sizeof volta20, "%s/.volta/tools/image/node/20.0.0/bin/node", home);
  touch_x(node24);
  touch_x(node242);
  touch_x(node22);
  touch_x(nvm24);
  touch_x(nvm22);
  touch_x(volta24);
  touch_x(volta20);

  char out[4096];
  World world;
  memset(&world, 0, sizeof world);
  add_override(&world, "/opt/homebrew/bin/node", 24);
  check(discover(&world, NULL, home, out, sizeof out) == 0, "homebrew found");
  check(strcmp(out, "/opt/homebrew/bin/node") == 0, "homebrew wins over newer mise");
  check(world.shell_calls == 0, "shell not asked when homebrew works");

  memset(&world, 0, sizeof world);
  add_override(&world, "/opt/homebrew/bin/node", 22);
  add_override(&world, "/opt/homebrew/opt/node@24/bin/node", 24);
  check(discover(&world, NULL, home, out, sizeof out) == 0, "keg-only node@24");
  check(strcmp(out, "/opt/homebrew/opt/node@24/bin/node") == 0, "keg path");
  check(world.shell_calls == 0, "keg skips the shell");

  memset(&world, 0, sizeof world);
  add_override(&world, "/opt/homebrew/bin/node", 22);
  add_override(&world, "/usr/local/bin/node", 18);
  check(discover(&world, NULL, home, out, sizeof out) == 0, "mise after old homebrew");
  check(strcmp(out, node24) == 0, "newest mise is 24.11 not 24.2");
  check(world.shell_calls == 0, "shell not asked when mise works");

  char bare[512];
  snprintf(bare, sizeof bare, "%s/no-managers", home);
  mkdir_p(bare);
  memset(&world, 0, sizeof world);
  check(discover(&world, NULL, bare, out, sizeof out) == -1, "nothing installed");
  check(world.shell_calls == 1, "shell asked once");

  memset(&world, 0, sizeof world);
  world.shell_text = "alias node='node'\n";
  check(discover(&world, NULL, bare, out, sizeof out) == -1, "alias is not a node");
  check(world.shell_calls == 1, "alias still one shell question");

  memset(&world, 0, sizeof world);
  world.shell_text = "hello from profile\n/opt/custom/bin/node\n";
  add_override(&world, "/opt/custom/bin/node", 24);
  check(discover(&world, NULL, bare, out, sizeof out) == 0, "shell path accepted");
  check(strcmp(out, "/opt/custom/bin/node") == 0, "shell path is the node");

  memset(&world, 0, sizeof world);
  world.shell_text = "/opt/old/bin/node\n";
  add_override(&world, "/opt/old/bin/node", 18);
  check(discover(&world, NULL, bare, out, sizeof out) == -1, "shell node 18 is refused");

  memset(&world, 0, sizeof world);
  add_override(&world, "/custom/node", 24);
  check(discover(&world, "/custom/node", home, out, sizeof out) == 0, "BAO_NODE wins");
  check(strcmp(out, "/custom/node") == 0, "BAO_NODE path");
  check(world.shell_calls == 0, "BAO_NODE skips the shell");

  memset(&world, 0, sizeof world);
  add_override(&world, "/custom/old", 22);
  add_override(&world, "/usr/local/bin/node", 24);
  check(discover(&world, "/custom/old", home, out, sizeof out) == 0, "old BAO_NODE falls through");
  check(strcmp(out, "/usr/local/bin/node") == 0, "usr local used");

  memset(&world, 0, sizeof world);
  add_override(&world, "/usr/local/bin/node", 24);
  check(discover(&world, "node", home, out, sizeof out) == 0, "relative BAO_NODE ignored");
  check(strcmp(out, "/usr/local/bin/node") == 0, "relative did not stick");

  char nvm_home[512];
  snprintf(nvm_home, sizeof nvm_home, "%s/nvm-only", home);
  mkdir_p(nvm_home);
  char only_nvm[512];
  snprintf(only_nvm, sizeof only_nvm, "%s/.nvm/versions/node/v24.0.1/bin/node", nvm_home);
  char old_nvm[512];
  snprintf(old_nvm, sizeof old_nvm, "%s/.nvm/versions/node/v22.16.0/bin/node", nvm_home);
  touch_x(only_nvm);
  touch_x(old_nvm);
  memset(&world, 0, sizeof world);
  check(discover(&world, NULL, nvm_home, out, sizeof out) == 0, "nvm found");
  check(strcmp(out, only_nvm) == 0, "nvm 24 beats nvm 22");

  char volta_home[512];
  snprintf(volta_home, sizeof volta_home, "%s/volta-only", home);
  char volta_new[512];
  snprintf(volta_new, sizeof volta_new, "%s/.volta/tools/image/node/24.4.0/bin/node", volta_home);
  char volta_old[512];
  snprintf(volta_old, sizeof volta_old, "%s/.volta/tools/image/node/20.11.0/bin/node", volta_home);
  touch_x(volta_new);
  touch_x(volta_old);
  memset(&world, 0, sizeof world);
  check(discover(&world, NULL, volta_home, out, sizeof out) == 0, "volta image found");
  check(strcmp(out, volta_new) == 0, "volta 24 beats volta 20");

  char shim_home[512];
  snprintf(shim_home, sizeof shim_home, "%s/volta-shim", home);
  char shim[512];
  snprintf(shim, sizeof shim, "%s/.volta/bin/node", shim_home);
  char shim_old[512];
  snprintf(shim_old, sizeof shim_old, "%s/.volta/tools/image/node/20.0.0/bin/node", shim_home);
  touch_x(shim_old);
  memset(&world, 0, sizeof world);
  add_override(&world, shim, 24);
  check(discover(&world, NULL, shim_home, out, sizeof out) == 0, "volta shim used");
  check(strcmp(out, shim) == 0, "shim path");

  check(strcmp(bao_login_shell(NULL, world_exec, &world), "/bin/zsh") == 0, "finder shell is zsh");
  check(strcmp(bao_login_shell("/bin/bash", world_exec, &world), "/bin/bash") == 0, "SHELL wins");
  check(bao_login_shell("zsh", world_exec, &world) != NULL, "relative SHELL is skipped");
  check(strcmp(bao_login_shell("zsh", world_exec, &world), "/bin/zsh") == 0, "relative SHELL falls through");
}

static void test_real_exec(const char *home) {
  char versioned[512];
  snprintf(versioned, sizeof versioned, "%s/bin/version-node", home);
  write_script(versioned, "#!/bin/sh\necho v24.19.0\n");
  check(bao_real_major(versioned, NULL) == 24, "node -v major");

  char old[512];
  snprintf(old, sizeof old, "%s/bin/old-node", home);
  write_script(old, "#!/bin/sh\necho v22.1.0\n");
  check(bao_real_major(old, NULL) == 22, "node 22 major");

  char shell[512];
  snprintf(shell, sizeof shell, "%s/bin/fake-shell", home);
  write_script(shell, "#!/bin/sh\nprintf '%s\\n' welcome /opt/homebrew/bin/node\n");
  char buf[256];
  check(bao_real_shell(shell, buf, sizeof buf, NULL) == 0, "fake shell runs");
  char accepted[256];
  check(bao_accept_shell_output(buf, accepted, sizeof accepted) == 1, "fake shell path");
  check(strcmp(accepted, "/opt/homebrew/bin/node") == 0, "fake shell chose the path");

  char alias_shell[512];
  snprintf(alias_shell, sizeof alias_shell, "%s/bin/alias-shell", home);
  write_script(alias_shell, "#!/bin/sh\nprintf '%s\\n' \"alias node='nope'\"\n");
  check(bao_real_shell(alias_shell, buf, sizeof buf, NULL) == 0, "alias shell exits 0");
  check(bao_accept_shell_output(buf, accepted, sizeof accepted) == 0, "real alias output rejected");

  char sleeper[512];
  snprintf(sleeper, sizeof sleeper, "%s/bin/sleep-shell", home);
  write_script(sleeper, "#!/bin/sh\nsleep 30\n");
  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(bao_real_shell(sleeper, buf, sizeof buf, NULL) != 0, "hung shell fails");
  long took = elapsed_ms(start);
  check(took < 5000, "hung shell is killed");
}

static void test_instance(const char *home) {
  bao_instance_release();
  int other = 0;
  check(bao_instance_acquire(home, &other) == 0, "first instance owns the lock");
  check(bao_instance_write_browser_pid(home, 4242) == 0, "browser pid stored");
  check(bao_read_browser_pid(home) == 4242, "pid reads back");
  int second = bao_instance_acquire(home, &other);
  check(second == 1, "second launch does not own the lock");
  check(other == 4242, "second launch sees the window pid");
  bao_instance_release();
  check(bao_instance_acquire(home, &other) == 0, "lock frees when the owner exits");
  bao_instance_release();
  check(bao_instance_write_browser_pid(home, 7) != 0, "pid write requires the lock");
}

static void test_port(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  check(fd >= 0, "socket");
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(0x7f000001);
  addr.sin_port = 0;
  check(bind(fd, (struct sockaddr *)&addr, sizeof addr) == 0, "bind");
  check(listen(fd, 1) == 0, "listen");
  socklen_t len = sizeof addr;
  check(getsockname(fd, (struct sockaddr *)&addr, &len) == 0, "getsockname");
  char port[16];
  snprintf(port, sizeof port, "%u", (unsigned)ntohs(addr.sin_port));
  check(bao_port_listening(port) == 1, "port is open");
  check(bao_wait_for_port(port, 0, 1000) == 0, "wait returns when the port is open");
  close(fd);
  check(bao_port_listening(port) == 0, "port is closed");
  check(bao_port_listening("nope") == 0, "bad port");

  pid_t child = fork();
  if (child == 0) _exit(0);
  check(child > 0, "fork child");
  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(bao_wait_for_port("1", (int)child, 5000) == -1, "dead child stops the wait");
  check(elapsed_ms(start) < 1500, "dead child does not wait out the timeout");
}

int main(void) {
  char tmpl[] = "/tmp/bao-launch-XXXXXX";
  char *home = mkdtemp(tmpl);
  if (!home) {
    fprintf(stderr, "mkdtemp failed\n");
    return 1;
  }
  test_versions();
  test_shell_output();
  test_discover(home);
  test_real_exec(home);
  test_instance(home);
  test_port();
  rm_rf(home);
  if (failed) {
    fprintf(stderr, "failed %d of %d\n", failed, checks);
    return 1;
  }
  printf("ok %d\n", checks);
  return 0;
}
