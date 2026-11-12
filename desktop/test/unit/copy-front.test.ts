import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bringCopyFront } from "../../src/engines/copy-front";
import { pinTestBrowser } from "../../src/launch";
import { scaledMs } from "../runtime";

pinTestBrowser();

const MACOS = path.join(process.cwd(), "desktop/packaging/macos");

function skip(): string | false {
  if (process.platform !== "darwin") return "bao-front is a macOS activation tool";
  const cc = spawnSync("cc", ["--version"], { encoding: "utf8" });
  return cc.error || cc.status !== 0 ? "needs cc on PATH" : false;
}

const PROBE = `#import <AppKit/AppKit.h>
#import <objc/runtime.h>

@interface BaoFrontProbe : NSObject
- (void)unhide;
- (BOOL)activateWithOptions:(NSUInteger)options;
@end

@implementation BaoFrontProbe
- (void)unhide {}
- (BOOL)activateWithOptions:(NSUInteger)options {
  const char *path = getenv("BAO_FRONT_PROBE");
  if (!path) return NO;
  NSArray<NSString *> *all = [[NSProcessInfo processInfo] arguments];
  if (all.count < 1) return NO;
  NSArray<NSString *> *argv = [all subarrayWithRange:NSMakeRange(1, all.count - 1)];
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"options": @(options), @"argv": argv } options:0 error:NULL];
  if (!data) return NO;
  return [data writeToFile:[NSString stringWithUTF8String:path] atomically:YES];
}
@end

static id fake;
static id hooked(id self, SEL _cmd, pid_t pid) {
  (void)self; (void)_cmd; (void)pid;
  return fake;
}

__attribute__((constructor)) static void install(void) {
  fake = [BaoFrontProbe new];
  Class cls = objc_getClass("NSRunningApplication");
  Method method = class_getClassMethod(cls, @selector(runningApplicationWithProcessIdentifier:));
  method_setImplementation(method, (IMP)hooked);
}
`;

const ORACLE = `#import <AppKit/AppKit.h>
#include <stdio.h>
int main(void) {
  printf("%lu\\n", (unsigned long)NSApplicationActivateAllWindows);
  return 0;
}
`;

test("a copy handoff spawns bao-front with that pid only and activates with the default option", { skip: skip(), timeout: scaledMs(60_000) }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-copy-front-"));
  const prior = {
    tool: process.env.BAO_FRONT_TOOL,
    dyld: process.env.DYLD_INSERT_LIBRARIES,
    probe: process.env.BAO_FRONT_PROBE,
  };
  try {
    const front = path.join(dir, "bao-front");
    const probe = path.join(dir, "probe.dylib");
    const oracle = path.join(dir, "oracle");
    const seenPath = path.join(dir, "seen.json");
    writeFileSync(path.join(dir, "probe.m"), PROBE);
    writeFileSync(path.join(dir, "oracle.m"), ORACLE);
    const compile = (args: string[]) => execFileSync("cc", ["-fobjc-arc", "-Wall", "-Wextra", "-Werror", ...args], { stdio: "inherit", timeout: scaledMs(60_000) });
    compile(["-O2", "-framework", "AppKit", path.join(MACOS, "bao-front.m"), "-o", front]);
    compile(["-dynamiclib", "-framework", "AppKit", path.join(dir, "probe.m"), "-o", probe]);
    compile(["-framework", "AppKit", path.join(dir, "oracle.m"), "-o", oracle]);
    const allWindows = Number(execFileSync(oracle, { encoding: "utf8", timeout: scaledMs(10_000) }).trim());
    assert.notEqual(allWindows, 0, "Apple's all-windows flag is a nonzero NSApplicationActivationOptions bit");
    const exe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const copy = path.join(dir, "copy");
    const pid = 4242;
    process.env.BAO_FRONT_TOOL = front;
    process.env.DYLD_INSERT_LIBRARIES = probe;
    process.env.BAO_FRONT_PROBE = seenPath;
    const ok = await bringCopyFront(exe, copy, [{ pid, ppid: 1, command: `${exe} --user-data-dir=${copy}` }]);
    assert.equal(ok, true);
    const seen = JSON.parse(readFileSync(seenPath, "utf8")) as { options: number; argv: string[] };
    assert.deepEqual(seen.argv, [String(pid)], "the handoff spawns bao-front with that pid and no other argument");
    assert.equal(seen.options & allWindows, 0, "activation does not ask for every window");
    assert.equal(seen.options, 0, "activation uses the default option, which sets no flags");
  } finally {
    if (prior.tool === undefined) delete process.env.BAO_FRONT_TOOL;
    else process.env.BAO_FRONT_TOOL = prior.tool;
    if (prior.dyld === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
    else process.env.DYLD_INSERT_LIBRARIES = prior.dyld;
    if (prior.probe === undefined) delete process.env.BAO_FRONT_PROBE;
    else process.env.BAO_FRONT_PROBE = prior.probe;
    rmSync(dir, { recursive: true, force: true });
  }
});
