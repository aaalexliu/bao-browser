#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Bring one process's app to the front. A pid only, never a bundle name, so this cannot pick the owner's Chrome by name.
   Do not unhide. On this Mac, unhide orders every on-screen window of a Chrome copy forward even when the app is not hidden. */

static BOOL onScreenLayer(NSDictionary *info) {
  return [info[(id)kCGWindowLayer] intValue] == 0;
}

static CFArrayRef onScreenWindows(void) {
  return CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
}

static BOOL pidHasOnScreenWindow(pid_t pid) {
  CFArrayRef list = onScreenWindows();
  if (!list) return NO;
  BOOL found = NO;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    NSDictionary *info = CFArrayGetValueAtIndex(list, i);
    if (onScreenLayer(info) && [info[(id)kCGWindowOwnerPID] intValue] == pid) { found = YES; break; }
  }
  CFRelease(list);
  return found;
}

/* The window in front of this process, before activation. Zero when this process is already in front. */
static int frontForeignWindow(pid_t pid) {
  CFArrayRef list = onScreenWindows();
  if (!list) return 0;
  int cover = 0;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    NSDictionary *info = CFArrayGetValueAtIndex(list, i);
    if (!onScreenLayer(info)) continue;
    if ([info[(id)kCGWindowOwnerPID] intValue] == pid) continue;
    cover = [info[(id)kCGWindowNumber] intValue];
    break;
  }
  CFRelease(list);
  return cover;
}

static BOOL pidAheadOf(pid_t pid, int cover) {
  CFArrayRef list = onScreenWindows();
  if (!list) return NO;
  BOOL ahead = NO;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    NSDictionary *info = CFArrayGetValueAtIndex(list, i);
    if (!onScreenLayer(info)) continue;
    if ([info[(id)kCGWindowNumber] intValue] == cover) break;
    if ([info[(id)kCGWindowOwnerPID] intValue] == pid) { ahead = YES; break; }
  }
  CFRelease(list);
  return ahead;
}

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
    pid_t pid = (pid_t)value;
    BOOL visible = pidHasOnScreenWindow(pid);
    int cover = visible ? frontForeignWindow(pid) : 0;
    BOOL ok = [app activateWithOptions:0];
    if (!ok) {
      fprintf(stderr, "bao-front: activate failed\n");
      return 1;
    }
    /* Activation moves the key window after this process returns. Wait until that window is ahead of the cover. */
    if (visible && cover) {
      for (int i = 0; i < 20 && !pidAheadOf(pid, cover); i++) usleep(50000);
    }
  }
  return 0;
}
