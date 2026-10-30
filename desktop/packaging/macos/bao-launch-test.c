#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE

#include "bao-launch.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* The hang cases wait out a deadline. bao_real_shell's 3 s one is checked
   once. The rest use this shorter one so the harness stays fast. It still
   leaves a new script time to start and write its pid file under load. */
#define TEST_DEADLINE_MS 1000

static int checks;
static int failed;

static void check(int cond, const char *msg) {
  checks++;
  if (cond) return;
  fprintf(stderr, "fail %s\n", msg);
  failed++;
}

static void check_under(int cond, const char *msg, const char *shell) {
  char line[256];
  snprintf(line, sizeof line, "%s under %s", msg, shell);
  check(cond, line);
}

static int capture_fast(const char *path, char *buf, size_t n) {
  char *argv[] = {(char *)path, NULL};
  return bao_run_capture(argv, buf, n, TEST_DEADLINE_MS);
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

static int write_script(const char *path, const char *body) {
  char dir[4096];
  snprintf(dir, sizeof dir, "%s", path);
  char *slash = strrchr(dir, '/');
  if (slash) {
    *slash = 0;
    mkdir_p(dir);
  }
  FILE *file = fopen(path, "w");
  if (!file) return -1;
  if (fputs(body, file) < 0) {
    fclose(file);
    return -1;
  }
  if (fclose(file) != 0) return -1;
  if (chmod(path, 0755) != 0) return -1;
  return 0;
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
  char only_nvm[1024];
  snprintf(only_nvm, sizeof only_nvm, "%s/.nvm/versions/node/v24.0.1/bin/node", nvm_home);
  char old_nvm[1024];
  snprintf(old_nvm, sizeof old_nvm, "%s/.nvm/versions/node/v22.16.0/bin/node", nvm_home);
  touch_x(only_nvm);
  touch_x(old_nvm);
  memset(&world, 0, sizeof world);
  check(discover(&world, NULL, nvm_home, out, sizeof out) == 0, "nvm found");
  check(strcmp(out, only_nvm) == 0, "nvm 24 beats nvm 22");

  char volta_home[512];
  snprintf(volta_home, sizeof volta_home, "%s/volta-only", home);
  char volta_new[1024];
  snprintf(volta_new, sizeof volta_new, "%s/.volta/tools/image/node/24.4.0/bin/node", volta_home);
  char volta_old[1024];
  snprintf(volta_old, sizeof volta_old, "%s/.volta/tools/image/node/20.11.0/bin/node", volta_home);
  touch_x(volta_new);
  touch_x(volta_old);
  memset(&world, 0, sizeof world);
  check(discover(&world, NULL, volta_home, out, sizeof out) == 0, "volta image found");
  check(strcmp(out, volta_new) == 0, "volta 24 beats volta 20");

  char shim_home[512];
  snprintf(shim_home, sizeof shim_home, "%s/volta-shim", home);
  char shim[1024];
  snprintf(shim, sizeof shim, "%s/.volta/bin/node", shim_home);
  char shim_old[1024];
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

static long read_pid_file(const char *path) {
  FILE *file = fopen(path, "r");
  if (!file) return -1;
  long pid = -1;
  if (fscanf(file, "%ld", &pid) != 1) pid = -1;
  fclose(file);
  if (pid <= 1) return -1;
  return pid;
}

static int waited_until_gone(long pid) {
  if (pid <= 1) return 0;
  for (int i = 0; i < 50; i++) {
    if (kill((pid_t)pid, 0) != 0) return errno == ESRCH;
    struct timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = 10L * 1000L * 1000L;
    nanosleep(&ts, NULL);
  }
  return 0;
}

static void reap_test_pid(long pid) {
  if (pid <= 1) return;
  if (kill((pid_t)pid, 0) == 0) kill((pid_t)pid, SIGKILL);
}

static void ignore_usr1(int sig) { (void)sig; }

static pid_t start_signal_storm(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = ignore_usr1;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;
  if (sigaction(SIGUSR1, &sa, NULL) != 0) return -1;
  pid_t child = fork();
  if (child == 0) {
    pid_t target = getppid();
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
      struct timespec now;
      clock_gettime(CLOCK_MONOTONIC, &now);
      long ms = (now.tv_sec - start.tv_sec) * 1000L + (now.tv_nsec - start.tv_nsec) / 1000000L;
      if (ms > 8000) _exit(0);
      if (kill(target, SIGUSR1) != 0) _exit(0);
    }
  }
  return child;
}

static void stop_signal_storm(pid_t child) {
  if (child > 0) {
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
  }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = SIG_DFL;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGUSR1, &sa, NULL);
}

static int build_escape_helper(const char *home, char *bin, size_t n) {
  char src[512];
  snprintf(src, sizeof src, "%s/bin/escape.c", home);
  snprintf(bin, n, "%s/bin/escape", home);
  if (write_script(src,
                   "#define _POSIX_C_SOURCE 200809L\n"
                   "#include <stdio.h>\n"
                   "#include <unistd.h>\n"
                   "#include <signal.h>\n"
                   "int main(int argc, char **argv) {\n"
                   "  (void)argc;\n"
                   "  if (fork() == 0) { for (;;) pause(); }\n"
                   "  char path[4096];\n"
                   "  snprintf(path, sizeof path, \"%s.pid\", argv[0]);\n"
                   "  if (setpgid(0, getpgid(getppid())) != 0) _exit(1);\n"
                   "  FILE *out = fopen(path, \"w\");\n"
                   "  if (!out) _exit(1);\n"
                   "  fprintf(out, \"%ld\\n\", (long)getpid());\n"
                   "  if (fclose(out) != 0) _exit(1);\n"
                   "  for (;;) pause();\n"
                   "}\n") != 0) return -1;
  pid_t cc = fork();
  if (cc < 0) return -1;
  if (cc == 0) {
    execlp("cc", "cc", "-std=c11", src, "-o", bin, (char *)0);
    _exit(127);
  }
  int status = 0;
  if (waitpid(cc, &status, 0) != cc) return -1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;
  return 0;
}

static int build_flood_helper(const char *home, char *bin, size_t n) {
  char src[512];
  snprintf(src, sizeof src, "%s/bin/flood.c", home);
  snprintf(bin, n, "%s/bin/flood", home);
  if (write_script(src,
                   "#define _GNU_SOURCE\n"
                   "#include <errno.h>\n"
                   "#include <fcntl.h>\n"
                   "#include <string.h>\n"
                   "#include <time.h>\n"
                   "#include <unistd.h>\n"
                   "int main(void) {\n"
                   "#ifdef F_SETPIPE_SZ\n"
                   "  fcntl(1, F_SETPIPE_SZ, 1 << 20);\n"
                   "#endif\n"
                   "  int flags = fcntl(1, F_GETFL, 0);\n"
                   "  if (flags >= 0) fcntl(1, F_SETFL, flags | O_NONBLOCK);\n"
                   "  char block[65536];\n"
                   "  memset(block, 'x', sizeof block);\n"
                   "  struct timespec start;\n"
                   "  clock_gettime(CLOCK_MONOTONIC, &start);\n"
                   "  for (;;) {\n"
                   "    struct timespec now;\n"
                   "    clock_gettime(CLOCK_MONOTONIC, &now);\n"
                   "    long ms = (now.tv_sec - start.tv_sec) * 1000L + (now.tv_nsec - start.tv_nsec) / 1000000L;\n"
                   "    if (ms >= 6000) _exit(0);\n"
                   "    ssize_t wrote = write(1, block, sizeof block);\n"
                   "    if (wrote < 0 && errno == EPIPE) _exit(0);\n"
                   "  }\n"
                   "}\n") != 0) return -1;
  pid_t cc = fork();
  if (cc < 0) return -1;
  if (cc == 0) {
    execlp("cc", "cc", "-std=c11", src, "-o", bin, (char *)0);
    _exit(127);
  }
  int status = 0;
  if (waitpid(cc, &status, 0) != cc) return -1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;
  return 0;
}

static void test_flood_deadline(const char *home) {
  char bin[512];
  check(build_flood_helper(home, bin, sizeof bin) == 0, "flood helper built");
  char buf[128];
  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  int rc = capture_fast(bin, buf, sizeof buf);
  long took = elapsed_ms(start);
  check(rc != 0, "flooding capture fails");
  check(took >= TEST_DEADLINE_MS && took < TEST_DEADLINE_MS + 1000, "flooding capture stays inside the deadline");
}

static void test_pty_stty(const char *home, const char *shell) {
  char script[512];
  snprintf(script, sizeof script, "%s/bin/stty-%s.sh", home, strrchr(shell, '/') + 1);
  char body[256];
  snprintf(body, sizeof body, "#!%s\nif stty -ixon < /dev/tty; then echo STTY_OK; else echo STTY_FAIL; fi\n", shell);
  check_under(write_script(script, body) == 0, "stty script written", shell);
  int master = posix_openpt(O_RDWR | O_NOCTTY);
  check(master >= 0, "pty master opens");
  if (master < 0) return;
  check(grantpt(master) == 0, "pty grant");
  check(unlockpt(master) == 0, "pty unlock");
  char *name = ptsname(master);
  check(name != NULL, "pty name");
  if (!name) {
    close(master);
    return;
  }
  char slavename[128];
  snprintf(slavename, sizeof slavename, "%s", name);
  int result[2];
  if (pipe(result) != 0) {
    check(0, "pty result pipe");
    close(master);
    return;
  }
  pid_t child = fork();
  if (child < 0) {
    check(0, "pty child");
    close(master);
    close(result[0]);
    close(result[1]);
    return;
  }
  if (child == 0) {
    close(master);
    close(result[0]);
    int slave = open(slavename, O_RDWR);
    if (slave < 0 || setsid() < 0 || ioctl(slave, TIOCSCTTY, 0) < 0) {
      dprintf(result[1], "setup\n");
      _exit(0);
    }
    tcsetpgrp(slave, getpid());
    dup2(slave, STDIN_FILENO);
    dup2(slave, STDOUT_FILENO);
    dup2(slave, STDERR_FILENO);
    if (slave > 2) close(slave);
    char out[160];
    memset(out, 0, sizeof out);
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);
    int rc = bao_real_shell(script, out, sizeof out, NULL);
    long took = elapsed_ms(start);
    dprintf(result[1], "%d %ld %s\n", rc, took, out);
    _exit(0);
  }
  close(result[1]);
  int flags = fcntl(master, F_GETFL, 0);
  if (flags >= 0) fcntl(master, F_SETFL, flags | O_NONBLOCK);
  struct timespec wait_start;
  clock_gettime(CLOCK_MONOTONIC, &wait_start);
  int status = 0;
  for (;;) {
    char junk[256];
    while (read(master, junk, sizeof junk) > 0) {
    }
    pid_t got = waitpid(child, &status, WNOHANG);
    if (got == child) break;
    if (elapsed_ms(wait_start) > 8000) {
      kill(child, SIGKILL);
      waitpid(child, &status, 0);
      break;
    }
    struct timespec pause;
    pause.tv_sec = 0;
    pause.tv_nsec = 20L * 1000L * 1000L;
    nanosleep(&pause, NULL);
  }
  close(master);
  char line[256];
  size_t used = 0;
  while (used + 1 < sizeof line) {
    ssize_t n = read(result[0], line + used, sizeof line - 1 - used);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    used += (size_t)n;
  }
  close(result[0]);
  line[used] = 0;
  int rc = 0;
  long took = 0;
  char out[160];
  memset(out, 0, sizeof out);
  int parsed = sscanf(line, "%d %ld %159s", &rc, &took, out);
  check_under(parsed >= 2, "pty result", shell);
  check_under(rc == 0, "pty stty capture succeeds", shell);
  check_under(took > 0 && took < 1500, "pty stty returns inside the deadline", shell);
  check_under(strcmp(out, "STTY_OK") == 0, "pty stty prints", shell);
}

static void test_real_exec(const char *home) {
  char versioned[512];
  snprintf(versioned, sizeof versioned, "%s/bin/version-node", home);
  check(write_script(versioned, "#!/bin/sh\necho v24.19.0\n") == 0, "version script written");
  check(bao_real_major(versioned, NULL) == 24, "node -v major");

  char old[512];
  snprintf(old, sizeof old, "%s/bin/old-node", home);
  check(write_script(old, "#!/bin/sh\necho v22.1.0\n") == 0, "old node script written");
  check(bao_real_major(old, NULL) == 22, "node 22 major");

  char shell[512];
  snprintf(shell, sizeof shell, "%s/bin/fake-shell", home);
  check(write_script(shell, "#!/bin/sh\nprintf '%s\\n' welcome /opt/homebrew/bin/node\n") == 0, "fake shell written");
  char buf[256];
  check(bao_real_shell(shell, buf, sizeof buf, NULL) == 0, "fake shell runs");
  char accepted[256];
  check(bao_accept_shell_output(buf, accepted, sizeof accepted) == 1, "fake shell path");
  check(strcmp(accepted, "/opt/homebrew/bin/node") == 0, "fake shell chose the path");

  char alias_shell[512];
  snprintf(alias_shell, sizeof alias_shell, "%s/bin/alias-shell", home);
  check(write_script(alias_shell, "#!/bin/sh\nprintf '%s\\n' \"alias node='nope'\"\n") == 0, "alias script written");
  check(bao_real_shell(alias_shell, buf, sizeof buf, NULL) == 0, "alias shell exits 0");
  check(bao_accept_shell_output(buf, accepted, sizeof accepted) == 0, "real alias output rejected");

  char sleeper[512];
  char sleeper_pid_path[1024];
  snprintf(sleeper, sizeof sleeper, "%s/bin/sleep-shell", home);
  snprintf(sleeper_pid_path, sizeof sleeper_pid_path, "%s.pid", sleeper);
  check(write_script(sleeper, "#!/bin/sh\nsleep 30 &\necho $! > \"$0.pid\"\nwait\n") == 0, "hung script written");
  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(bao_real_shell(sleeper, buf, sizeof buf, NULL) != 0, "hung shell fails");
  long took = elapsed_ms(start);
  check(took < 5000, "hung shell is killed");
  long sleeper_pid = read_pid_file(sleeper_pid_path);
  check(sleeper_pid > 1, "hung sleeper pid recorded");
  check(waited_until_gone(sleeper_pid), "hung sleeper is dead");
  reap_test_pid(sleeper_pid);

  char holder[512];
  char holder_pid_path[1024];
  snprintf(holder, sizeof holder, "%s/bin/hold-stdout", home);
  snprintf(holder_pid_path, sizeof holder_pid_path, "%s.pid", holder);
  check(write_script(holder, "#!/bin/sh\n(trap '' HUP; exec sleep 30) &\necho $! > \"$0.pid\"\nexit 0\n") == 0, "holder script written");
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(bao_real_shell(holder, buf, sizeof buf, NULL) != 0, "stdout holder fails");
  took = elapsed_ms(start);
  check(took < 1500, "stdout holder returns before the deadline");
  long holder_pid = read_pid_file(holder_pid_path);
  check(holder_pid > 1, "stdout holder pid recorded");
  check(waited_until_gone(holder_pid), "stdout holder is dead");
  reap_test_pid(holder_pid);

  char storm_shell[512];
  char storm_pid_path[1024];
  snprintf(storm_shell, sizeof storm_shell, "%s/bin/storm-shell", home);
  snprintf(storm_pid_path, sizeof storm_pid_path, "%s.pid", storm_shell);
  check(write_script(storm_shell, "#!/bin/sh\nsleep 30 &\necho $! > \"$0.pid\"\nwait\n") == 0, "storm script written");
  pid_t storm = start_signal_storm();
  check(storm > 0, "signal storm started");
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(capture_fast(storm_shell, buf, sizeof buf) != 0, "signal storm capture fails");
  took = elapsed_ms(start);
  stop_signal_storm(storm);
  check(took < TEST_DEADLINE_MS + 2000, "signal storm stays inside the deadline");
  long storm_pid = read_pid_file(storm_pid_path);
  check(storm_pid > 1, "signal storm sleeper pid recorded");
  check(waited_until_gone(storm_pid), "signal storm sleeper is dead");
  reap_test_pid(storm_pid);

  struct sigaction ignore_child;
  struct sigaction previous_child;
  memset(&ignore_child, 0, sizeof ignore_child);
  ignore_child.sa_handler = SIG_IGN;
  sigemptyset(&ignore_child.sa_mask);
  check(sigaction(SIGCHLD, &ignore_child, &previous_child) == 0, "SIGCHLD ignored");
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(bao_real_shell(holder, buf, sizeof buf, NULL) != 0, "reaped child capture fails");
  took = elapsed_ms(start);
  sigaction(SIGCHLD, &previous_child, NULL);
  check(took < 5000, "reaped child returns");
  long reaped_pid = read_pid_file(holder_pid_path);
  check(reaped_pid > 1, "reaped child pid recorded");
  check(waited_until_gone(reaped_pid), "reaped child group is dead");
  reap_test_pid(reaped_pid);

  char escape_bin[512];
  check(build_escape_helper(home, escape_bin, sizeof escape_bin) == 0, "escape helper built");
  char escape_pid_path[1024];
  snprintf(escape_pid_path, sizeof escape_pid_path, "%s.pid", escape_bin);
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(capture_fast(escape_bin, buf, sizeof buf) != 0, "escaped child capture fails");
  took = elapsed_ms(start);
  check(took < TEST_DEADLINE_MS + 2000, "escaped child returns");
  long escape_pid = read_pid_file(escape_pid_path);
  check(escape_pid > 1, "escaped child pid recorded");
  check(waited_until_gone(escape_pid), "escaped child is dead");
  reap_test_pid(escape_pid);

  char monitor[512];
  char monitor_pid_path[1024];
  snprintf(monitor, sizeof monitor, "%s/bin/monitor-shell", home);
  snprintf(monitor_pid_path, sizeof monitor_pid_path, "%s.pid", monitor);
  check(write_script(monitor, "#!/bin/bash\nset -m\n(trap '' HUP; exec sleep 30) &\necho $! > \"$0.pid\"\nexit 0\n") == 0, "monitor script written");
  clock_gettime(CLOCK_MONOTONIC, &start);
  check(bao_real_shell(monitor, buf, sizeof buf, NULL) != 0, "monitor holder fails");
  took = elapsed_ms(start);
  check(took < 1500, "monitor holder returns before the deadline");
  long monitor_pid = read_pid_file(monitor_pid_path);
  check(monitor_pid > 1, "monitor holder pid recorded");
  check(waited_until_gone(monitor_pid), "monitor holder is dead");
  reap_test_pid(monitor_pid);
  test_flood_deadline(home);
  /* /bin/sh is bash 3.2 on macOS and often dash on Linux. bash 3.2 and zsh
     reset SIGTTOU in the commands they start. dash clears the signal mask. */
  const char *shells[] = {"/bin/sh", "/bin/zsh", "/bin/dash"};
  for (size_t i = 0; i < sizeof shells / sizeof shells[0]; i++) {
    if (i == 0 || bao_real_is_exec(shells[i], NULL)) test_pty_stty(home, shells[i]);
  }
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
  /* Backlog 1 fills after the first probe connect, and the next connect stalls. */
  check(listen(fd, 16) == 0, "listen");
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

static void test_bundle(const char *home) {
  char resources[4096];
  char found[4096];
  char want[4096];
  snprintf(resources, sizeof resources, "%s/bundle/Resources", home);
  mkdir_p(resources);
  check(bao_find_browser(found, sizeof found, resources) == 0, "no browser in an empty Resources");
  check(found[0] == 0, "no browser leaves the path empty");
  snprintf(want, sizeof want, "%s/Chromium.app/Contents/MacOS/Google Chrome for Testing", resources);
  touch_x(want);
  check(bao_find_browser(found, sizeof found, resources) == 1 && strcmp(found, want) == 0, "finds Chrome for Testing inside Chromium.app");
  snprintf(want, sizeof want, "%s/Chromium.app/Contents/MacOS/Chromium", resources);
  touch_x(want);
  check(bao_find_browser(found, sizeof found, resources) == 1 && strcmp(found, want) == 0, "prefers Chromium");
  check(bao_find_browser(found, 8, resources) == 0, "a short buffer finds nothing");

  char saved[4096];
  const char *env = getenv("HOME");
  snprintf(saved, sizeof saved, "%s", env ? env : "");
  char user[4096];
  setenv("HOME", home, 1);
  bao_user_home(user, sizeof user);
  check(strcmp(user, home) == 0, "user home is an absolute HOME");
  bao_user_home(user, 4);
  check(user[0] == 0, "a short buffer gets no home");
  setenv("HOME", "relative", 1);
  bao_user_home(user, sizeof user);
  check(user[0] == '/', "a relative HOME falls back to the passwd entry");
  if (env) setenv("HOME", saved, 1);
  else unsetenv("HOME");
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
  test_bundle(home);
  rm_rf(home);
  if (failed) {
    fprintf(stderr, "failed %d of %d\n", failed, checks);
    return 1;
  }
  printf("ok %d\n", checks);
  return 0;
}
