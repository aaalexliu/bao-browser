// Records one window with ScreenCaptureKit.
// The filter is SCContentFilter desktopIndependentWindow. This file has no
// display crop. It does not call CGRequestScreenCaptureAccess. When preflight
// is false, SCShareableContent is not called.

#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString *const kShareAPI = @"SCShareableContent getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:";
static NSString *const kCaptureAPI = @"SCScreenshotManager captureImageWithFilter:configuration:completionHandler:";

static BOOL pathOk(NSString *file) {
    if (file.length == 0 || [file containsString:@".."]) return NO;
    NSArray<NSString *> *roots = @[
        @"/tmp/",
        @"/private/tmp/",
        @"/var/folders/",
        @"/private/var/folders/",
        @"/Users/alexliu/Library/Application Support/Cursor/AgentStores/",
    ];
    for (NSString *root in roots) {
        if ([file hasPrefix:root]) return YES;
    }
    return NO;
}

static void writeJSON(NSDictionary *obj, NSString *path) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingPrettyPrinted error:nil];
    if (!data) data = [@"{}\n" dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableData *out = [data mutableCopy];
    [out appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:out];
    if (path.length && pathOk(path)) [out writeToFile:path atomically:YES];
}

static NSString *apiError(NSString *api, NSError *error) {
    if (!error) return [NSString stringWithFormat:@"%@ returned no image and no NSError", api];
    return [NSString stringWithFormat:@"%@ refused: domain %@ code %ld %@",
        api, error.domain, (long)error.code, error.localizedDescription ?: @""];
}

static SCShareableContent *waitShareable(NSError **errorOut) {
    __block SCShareableContent *content = nil;
    __block NSError *error = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                               onScreenWindowsOnly:YES
                                                 completionHandler:^(SCShareableContent *next, NSError *err) {
        content = next;
        error = err;
        dispatch_semaphore_signal(sem);
    }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
    while (dispatch_semaphore_wait(sem, DISPATCH_TIME_NOW) != 0) {
        if (deadline.timeIntervalSinceNow < 0) {
            if (errorOut) *errorOut = [NSError errorWithDomain:@"dev.bao.windowvideo" code:1 userInfo:@{NSLocalizedDescriptionKey: @"timed out waiting for SCShareableContent"}];
            return nil;
        }
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    }
    if (errorOut) *errorOut = error;
    return content;
}

static BOOL preflightDenied(NSMutableDictionary *obj) {
    BOOL granted = CGPreflightScreenCaptureAccess();
    obj[@"screenCapture"] = @(granted);
    obj[@"exe"] = NSBundle.mainBundle.executablePath ?: @"";
    if (granted) return NO;
    obj[@"ok"] = @NO;
    obj[@"api"] = @"CGPreflightScreenCaptureAccess";
    obj[@"error"] = [NSString stringWithFormat:@"CGPreflightScreenCaptureAccess returned false for %@. %@ was not called because that method presents the Screen Recording prompt when access is not already granted.",
        obj[@"exe"], kShareAPI];
    return YES;
}

static NSSet<NSNumber *> *pidSet(NSString *text) {
    NSMutableSet<NSNumber *> *pids = [NSMutableSet set];
    for (NSString *part in [text componentsSeparatedByString:@","]) {
        int pid = part.intValue;
        if (pid > 0) [pids addObject:@(pid)];
    }
    return pids;
}

static SCWindow *windowForPids(SCShareableContent *content, NSSet<NSNumber *> *pids) {
    SCWindow *best = nil;
    double area = 0;
    for (SCWindow *window in content.windows) {
        pid_t pid = window.owningApplication.processID;
        if (![pids containsObject:@(pid)]) continue;
        if (!window.onScreen || window.windowLayer != 0) continue;
        double next = window.frame.size.width * window.frame.size.height;
        if (next > area) {
            area = next;
            best = window;
        }
    }
    return best;
}

static BOOL writePNG(CGImageRef image, NSString *path, NSError **errorOut) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
    if (!dest) {
        if (errorOut) *errorOut = [NSError errorWithDomain:@"dev.bao.windowvideo" code:2 userInfo:@{NSLocalizedDescriptionKey: @"CGImageDestinationCreateWithURL failed"}];
        return NO;
    }
    CGImageDestinationAddImage(dest, image, NULL);
    BOOL ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
    if (!ok && errorOut) *errorOut = [NSError errorWithDomain:@"dev.bao.windowvideo" code:3 userInfo:@{NSLocalizedDescriptionKey: @"CGImageDestinationFinalize failed"}];
    return ok;
}

static NSDictionary *captureWindow(SCWindow *window, NSString *path) {
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    SCStreamConfiguration *config = [SCStreamConfiguration new];
    CGFloat scale = NSScreen.mainScreen.backingScaleFactor ?: 2;
    config.width = (NSInteger)llround(window.frame.size.width * scale);
    config.height = (NSInteger)llround(window.frame.size.height * scale);
    config.showsCursor = NO;
    config.capturesAudio = NO;
    __block CGImageRef image = nil;
    __block NSError *error = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef next, NSError *err) {
        if (next) image = CGImageRetain(next);
        error = err;
        dispatch_semaphore_signal(sem);
    }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
    while (dispatch_semaphore_wait(sem, DISPATCH_TIME_NOW) != 0) {
        if (deadline.timeIntervalSinceNow < 0) {
            return @{@"ok": @NO, @"api": kCaptureAPI, @"error": @"timed out waiting for SCScreenshotManager"};
        }
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    }
    if (!image) return @{@"ok": @NO, @"api": kCaptureAPI, @"error": apiError(kCaptureAPI, error)};
    NSError *writeError = nil;
    BOOL wrote = writePNG(image, path, &writeError);
    size_t w = CGImageGetWidth(image);
    size_t h = CGImageGetHeight(image);
    CGImageRelease(image);
    if (!wrote) return @{@"ok": @NO, @"api": @"CGImageDestinationFinalize", @"error": writeError.localizedDescription ?: @"png write failed"};
    return @{
        @"ok": @YES,
        @"api": kCaptureAPI,
        @"windowId": @(window.windowID),
        @"pid": @(window.owningApplication.processID),
        @"width": @(w),
        @"height": @(h),
    };
}

static NSDictionary *flagsFrom(NSArray<NSString *> *args) {
    NSMutableDictionary<NSString *, NSString *> *flags = [NSMutableDictionary dictionary];
    for (NSUInteger i = 1; i + 1 < args.count; i += 2) flags[args[i]] = args[i + 1];
    return flags;
}

// Re-exported from CoreGraphics as SLSInitialize. An LSUIElement launched
// with `open -g` leaves did_initialize false: NSApplication and an unshown
// window do not set it, and SCContentFilter then aborts in
// SLSGetDisplaysWithRect (CGS_REQUIRE_INIT). This does not request access.
extern void CGSInitialize(void);

static void connectWindowServer(void) {
    CGSInitialize();
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

int main(int argc, char **argv) {
    @autoreleasepool {
        connectWindowServer();
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        NSString *resultPath = @"";
        for (int i = 1; i < argc; i++) {
            NSString *arg = [NSString stringWithUTF8String:argv[i]];
            if ([arg isEqualToString:@"--result"] && i + 1 < argc) {
                resultPath = [NSString stringWithUTF8String:argv[++i]];
                continue;
            }
            [args addObject:arg];
        }
        NSString *cmd = args.firstObject ?: @"probe";
        NSMutableDictionary *obj = [NSMutableDictionary dictionary];
        if (preflightDenied(obj)) {
            writeJSON(obj, resultPath);
            return 1;
        }
        if ([cmd isEqualToString:@"probe"]) {
            NSError *error = nil;
            SCShareableContent *content = waitShareable(&error);
            if (!content) {
                obj[@"ok"] = @NO;
                obj[@"api"] = kShareAPI;
                obj[@"error"] = apiError(kShareAPI, error);
                writeJSON(obj, resultPath);
                return 1;
            }
            obj[@"ok"] = @YES;
            obj[@"api"] = kShareAPI;
            obj[@"displays"] = @(content.displays.count);
            obj[@"windows"] = @(content.windows.count);
            writeJSON(obj, resultPath);
            return 0;
        }
        NSDictionary *flags = flagsFrom(args);
        NSSet<NSNumber *> *pids = pidSet(flags[@"--pid"] ?: @"");
        if (pids.count == 0) {
            obj[@"ok"] = @NO;
            obj[@"error"] = @"--pid is required";
            writeJSON(obj, resultPath);
            return 1;
        }
        if ([cmd isEqualToString:@"shot"]) {
            NSString *out = flags[@"--out"] ?: @"";
            if (!pathOk(out)) {
                obj[@"ok"] = @NO;
                obj[@"error"] = @"shot output path is not allowed";
                writeJSON(obj, resultPath);
                return 1;
            }
            NSError *error = nil;
            SCShareableContent *content = waitShareable(&error);
            if (!content) {
                obj[@"ok"] = @NO;
                obj[@"api"] = kShareAPI;
                obj[@"error"] = apiError(kShareAPI, error);
                writeJSON(obj, resultPath);
                return 1;
            }
            SCWindow *window = windowForPids(content, pids);
            if (!window) {
                obj[@"ok"] = @NO;
                obj[@"error"] = @"no on-screen window for that pid";
                writeJSON(obj, resultPath);
                return 1;
            }
            NSDictionary *shot = captureWindow(window, out);
            [obj addEntriesFromDictionary:shot];
            writeJSON(obj, resultPath);
            return [shot[@"ok"] boolValue] ? 0 : 1;
        }
        if ([cmd isEqualToString:@"record"]) {
            NSString *dir = flags[@"--dir"] ?: @"";
            if (!pathOk(dir) || ![[NSFileManager defaultManager] fileExistsAtPath:dir]) {
                obj[@"ok"] = @NO;
                obj[@"error"] = @"record directory is not allowed";
                writeJSON(obj, resultPath);
                return 1;
            }
            NSString *stop = [dir stringByAppendingPathComponent:@"stop"];
            NSString *statusPath = [dir stringByAppendingPathComponent:@"status.json"];
            [@(getpid()).stringValue writeToFile:[dir stringByAppendingPathComponent:@"pid"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:180];
            NSInteger frames = 0;
            NSNumber *windowId = @0;
            NSNumber *pid = @0;
            NSNumber *width = @0;
            NSNumber *height = @0;
            while (![[NSFileManager defaultManager] fileExistsAtPath:stop] && deadline.timeIntervalSinceNow > 0 && frames < 2000) {
                NSDate *tick = [NSDate date];
                NSError *error = nil;
                SCShareableContent *content = waitShareable(&error);
                SCWindow *window = content ? windowForPids(content, pids) : nil;
                if (window) {
                    frames += 1;
                    NSString *frame = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"frame-%04ld.png", (long)frames]];
                    NSDictionary *shot = captureWindow(window, frame);
                    if (![shot[@"ok"] boolValue]) {
                        frames -= 1;
                    } else {
                        windowId = shot[@"windowId"];
                        pid = shot[@"pid"];
                        width = shot[@"width"];
                        height = shot[@"height"];
                    }
                }
                NSTimeInterval spent = -[tick timeIntervalSinceNow];
                if (spent < 0.2) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.2 - spent, false);
            }
            obj[@"ok"] = @(frames > 0);
            obj[@"frames"] = @(frames);
            obj[@"windowId"] = windowId;
            obj[@"pid"] = pid;
            obj[@"width"] = width;
            obj[@"height"] = height;
            if (frames == 0) obj[@"error"] = @"no frame of that window";
            writeJSON(obj, statusPath);
            return frames > 0 ? 0 : 1;
        }
        obj[@"ok"] = @NO;
        obj[@"error"] = [NSString stringWithFormat:@"unknown command %@", cmd];
        writeJSON(obj, resultPath);
        return 1;
    }
}
