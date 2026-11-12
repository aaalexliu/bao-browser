#import <AppKit/AppKit.h>
#include <stdio.h>
#include <stdlib.h>

/* Bring one process's app to the front. A pid only, never a bundle name, so this cannot pick the owner's Chrome by name. */
int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: bao-front <pid>\n");
    return 2;
  }
  char *end = NULL;
  long value = strtol(argv[1], &end, 10);
  if (end == argv[1] || *end || value <= 1 || value > 0x7fffffff) {
    fprintf(stderr, "bao-front: pid is not a process id\n");
    return 2;
  }
  @autoreleasepool {
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)value];
    if (!app) {
      fprintf(stderr, "bao-front: no application for that pid\n");
      return 1;
    }
    [app unhide];
    BOOL ok = [app activateWithOptions:NSApplicationActivateAllWindows];
    if (!ok) {
      fprintf(stderr, "bao-front: activate failed\n");
      return 1;
    }
  }
  return 0;
}
