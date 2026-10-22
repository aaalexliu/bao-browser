// Floating capture bar. JSON lines on stdin, events on stdout.
// Shortcuts: ctrl-opt-cmd R start, period stop, P pause.
// The act line names the ask and the site. Bao.app posts that same text and sets its Dock badge.

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>

static const UInt32 kHotStart = 1;
static const UInt32 kHotStop = 2;
static const UInt32 kHotPause = 3;

static NSPanel *panel;
static NSTextField *banner;
static NSTextField *timeLabel;
static NSButton *showButton;
static NSTextField *notifyLabel;
static NSButton *notifyButton;
static NSTextView *stepsView;
static NSTextField *field;
static NSButton *pauseButton;
static NSString *const kNotifySettingsURL = @"x-apple.systempreferences:com.apple.Notifications-Settings.extension";
static BOOL paused = NO;
static NSLock *outLock;

static void emit(NSDictionary *obj) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    if (!data) return;
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    [outLock lock];
    @try {
        [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
    } @catch (__unused NSException *ex) {
    }
    [outLock unlock];
}

static void setBadge(NSString *label) {
    [[NSApp dockTile] setBadgeLabel:label];
}

static void renderSteps(NSArray *steps) {
    NSMutableString *text = [NSMutableString string];
    NSUInteger i = 1;
    for (id item in steps) {
        if (![item isKindOfClass:[NSString class]]) continue;
        [text appendFormat:@"%lu. %@\n", (unsigned long)i, item];
        i += 1;
    }
    if (text.length == 0) [text setString:@"No steps yet.\n"];
    stepsView.string = text;
}

static void applyPaused(BOOL next) {
    paused = next;
    pauseButton.title = paused ? @"Resume" : @"Pause";
}

static BOOL shotPathOk(NSString *file) {
    if (file.length == 0 || [file containsString:@".."]) return NO;
    NSArray<NSString *> *roots = @[@"/tmp/", @"/private/tmp/", @"/var/folders/", @"/opt/cursor/artifacts/"];
    for (NSString *root in roots) {
        if ([file hasPrefix:root]) return YES;
    }
    return NO;
}

static void handle(NSDictionary *msg) {
    NSString *cmd = msg[@"cmd"];
    if ([cmd isEqualToString:@"show"] || [cmd isEqualToString:@"steps"]) {
        applyPaused([msg[@"paused"] boolValue]);
        renderSteps(msg[@"steps"] ?: @[]);
        [panel orderFrontRegardless];
        return;
    }
    if ([cmd isEqualToString:@"hide"]) {
        [panel orderOut:nil];
        return;
    }
    if ([cmd isEqualToString:@"act"]) {
        NSString *title = msg[@"title"] ?: @"You need to act";
        NSString *detail = [msg[@"detail"] isKindOfClass:[NSString class]] ? msg[@"detail"] : @"";
        banner.stringValue = title;
        banner.hidden = NO;
        timeLabel.stringValue = detail;
        timeLabel.hidden = detail.length == 0;
        showButton.hidden = NO;
        [panel orderFrontRegardless];
        emit(@{@"event": @"acted", @"badge": @"", @"title": title, @"detail": detail, @"notified": @NO});
        return;
    }
    if ([cmd isEqualToString:@"clear-badge"]) {
        banner.hidden = YES;
        timeLabel.hidden = YES;
        showButton.hidden = YES;
        setBadge(nil);
        emit(@{@"event": @"badge", @"badge": [NSApp dockTile].badgeLabel ?: @""});
        return;
    }
    if ([cmd isEqualToString:@"notify-off"]) {
        notifyLabel.hidden = NO;
        notifyButton.hidden = NO;
        [panel orderFrontRegardless];
        emit(@{
            @"event": @"notify-off",
            @"title": notifyLabel.stringValue ?: @"",
            @"button": notifyButton.title ?: @"",
            @"url": kNotifySettingsURL,
        });
        return;
    }
    if ([cmd isEqualToString:@"notify-clear"]) {
        notifyLabel.hidden = YES;
        notifyButton.hidden = YES;
        emit(@{@"event": @"notify-clear"});
        return;
    }
    /* Fixture driver. performClick runs the same action as a mouse click. */
    if ([cmd isEqualToString:@"click"]) {
        NSString *title = msg[@"title"];
        if (![title isKindOfClass:[NSString class]]) return;
        if ([msg[@"text"] isKindOfClass:[NSString class]]) field.stringValue = msg[@"text"];
        for (NSView *sub in panel.contentView.subviews) {
            if (![sub isKindOfClass:[NSButton class]]) continue;
            NSButton *button = (NSButton *)sub;
            if (![button.title isEqualToString:title]) continue;
            [button performClick:nil];
            return;
        }
        return;
    }
    if ([cmd isEqualToString:@"shot"]) {
        NSString *file = msg[@"file"];
        if (![file isKindOfClass:[NSString class]] || !shotPathOk(file)) return;
        [panel orderFrontRegardless];
        [panel displayIfNeeded];
        NSView *view = panel.contentView;
        NSRect bounds = view.bounds;
        NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:bounds];
        if (!rep) return;
        [view cacheDisplayInRect:bounds toBitmapImageRep:rep];
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![png writeToFile:file atomically:YES]) return;
        emit(@{@"event": @"shot", @"file": file, @"bytes": @(png.length)});
    }
}

static void onPause(id sender) {
    (void)sender;
    emit(@{@"event": paused ? @"resume" : @"pause"});
    applyPaused(!paused);
}

static void onNote(id sender) {
    (void)sender;
    NSString *text = field.stringValue ?: @"";
    if (text.length == 0) return;
    emit(@{@"event": @"note", @"text": text});
    field.stringValue = @"";
}

static void onCheck(id sender) {
    (void)sender;
    NSString *text = field.stringValue ?: @"";
    if (text.length == 0) return;
    emit(@{@"event": @"check", @"text": text});
    field.stringValue = @"";
}

static void onDiscard(id sender) {
    (void)sender;
    emit(@{@"event": @"discard"});
}

static void onShowWindow(id sender) {
    (void)sender;
    emit(@{@"event": @"show-window"});
}

static void onOpenSettings(id sender) {
    (void)sender;
    NSURL *url = [NSURL URLWithString:kNotifySettingsURL];
    if (url) [[NSWorkspace sharedWorkspace] openURL:url];
}

static OSStatus hotkeyHandler(EventHandlerCallRef next, EventRef event, void *user) {
    (void)next; (void)user;
    EventHotKeyID hid = {0};
    GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(hid), NULL, &hid);
    NSString *name = hid.id == kHotStart ? @"start" : hid.id == kHotStop ? @"stop" : @"pause";
    emit(@{@"event": @"hotkey", @"name": name});
    return noErr;
}

static void installHotkeys(void) {
    EventTypeSpec spec = { kEventClassKeyboard, kEventHotKeyPressed };
    InstallApplicationEventHandler(&hotkeyHandler, 1, &spec, NULL, NULL);
    EventHotKeyID start = { 'baoC', kHotStart };
    EventHotKeyID stop = { 'baoC', kHotStop };
    EventHotKeyID pause = { 'baoC', kHotPause };
    EventHotKeyRef ref;
    OSStatus startStatus = RegisterEventHotKey(kVK_ANSI_R, controlKey | optionKey | cmdKey, start, GetApplicationEventTarget(), 0, &ref);
    OSStatus stopStatus = RegisterEventHotKey(kVK_ANSI_Period, controlKey | optionKey | cmdKey, stop, GetApplicationEventTarget(), 0, &ref);
    OSStatus pauseStatus = RegisterEventHotKey(kVK_ANSI_P, controlKey | optionKey | cmdKey, pause, GetApplicationEventTarget(), 0, &ref);
    emit(@{@"event": @"hotkeys", @"start": @(startStatus), @"stop": @(stopStatus), @"pause": @(pauseStatus)});
}

static void readStdin(void) {
    NSFileHandle *input = [NSFileHandle fileHandleWithStandardInput];
    NSMutableData *buf = [NSMutableData data];
    while (1) {
        NSData *chunk = [input availableData];
        if (chunk.length == 0) break;
        [buf appendData:chunk];
        while (1) {
            const void *bytes = buf.bytes;
            NSUInteger len = buf.length;
            NSUInteger nl = NSNotFound;
            for (NSUInteger i = 0; i < len; i++) {
                if (((const char *)bytes)[i] == '\n') { nl = i; break; }
            }
            if (nl == NSNotFound) break;
            NSData *line = [buf subdataWithRange:NSMakeRange(0, nl)];
            [buf replaceBytesInRange:NSMakeRange(0, nl + 1) withBytes:NULL length:0];
            if (line.length == 0) continue;
            NSDictionary *msg = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
            if (![msg isKindOfClass:[NSDictionary class]]) continue;
            dispatch_async(dispatch_get_main_queue(), ^{ handle(msg); });
        }
    }
    dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
}

@interface BarApp : NSObject <NSApplicationDelegate>
@end

@implementation BarApp
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    (void)note;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSRect frame = NSMakeRect(40, 80, 380, 620);
    panel = [[NSPanel alloc] initWithContentRect:frame
        styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskNonactivatingPanel | NSWindowStyleMaskUtilityWindow | NSWindowStyleMaskClosable)
        backing:NSBackingStoreBuffered
        defer:NO];
    panel.title = @"Bao capture";
    panel.level = NSFloatingWindowLevel;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    panel.hidesOnDeactivate = NO;
    panel.floatingPanel = YES;
    panel.becomesKeyOnlyIfNeeded = YES;
    NSView *content = panel.contentView;
    banner = [NSTextField labelWithString:@"You need to act"];
    banner.hidden = YES;
    banner.frame = NSMakeRect(16, 496, 348, 40);
    banner.font = [NSFont boldSystemFontOfSize:14];
    banner.textColor = [NSColor systemRedColor];
    banner.maximumNumberOfLines = 2;
    banner.lineBreakMode = NSLineBreakByWordWrapping;
    banner.cell.wraps = YES;
    [content addSubview:banner];
    timeLabel = [NSTextField labelWithString:@""];
    timeLabel.hidden = YES;
    timeLabel.frame = NSMakeRect(16, 456, 348, 36);
    timeLabel.font = [NSFont systemFontOfSize:12];
    timeLabel.maximumNumberOfLines = 2;
    timeLabel.lineBreakMode = NSLineBreakByWordWrapping;
    timeLabel.cell.wraps = YES;
    [content addSubview:timeLabel];
    showButton = [NSButton buttonWithTitle:@"Show window" target:self action:@selector(showWindow:)];
    showButton.hidden = YES;
    showButton.frame = NSMakeRect(16, 420, 130, 28);
    [content addSubview:showButton];

    notifyLabel = [NSTextField labelWithString:@"Notifications are off for Bao"];
    notifyLabel.hidden = YES;
    notifyLabel.frame = NSMakeRect(16, 580, 348, 20);
    notifyLabel.font = [NSFont systemFontOfSize:13];
    notifyLabel.lineBreakMode = NSLineBreakByClipping;
    [content addSubview:notifyLabel];
    notifyButton = [NSButton buttonWithTitle:@"Open Settings" target:self action:@selector(openSettings:)];
    notifyButton.hidden = YES;
    notifyButton.frame = NSMakeRect(16, 544, 140, 28);
    [content addSubview:notifyButton];

    pauseButton = [NSButton buttonWithTitle:@"Pause" target:self action:@selector(pause:)];
    pauseButton.frame = NSMakeRect(16, 348, 72, 28);
    [content addSubview:pauseButton];

    NSButton *noteButton = [NSButton buttonWithTitle:@"Add note" target:self action:@selector(note:)];
    noteButton.frame = NSMakeRect(96, 348, 88, 28);
    [content addSubview:noteButton];
    NSButton *check = [NSButton buttonWithTitle:@"Add check" target:self action:@selector(check:)];
    check.frame = NSMakeRect(192, 348, 92, 28);
    [content addSubview:check];
    NSButton *discard = [NSButton buttonWithTitle:@"Discard" target:self action:@selector(discard:)];
    discard.frame = NSMakeRect(292, 348, 72, 28);
    [content addSubview:discard];

    field = [[NSTextField alloc] initWithFrame:NSMakeRect(16, 316, 348, 24)];
    field.placeholderString = @"Note or check";
    [content addSubview:field];

    NSTextField *keys = [NSTextField labelWithString:@"⌃⌥⌘R start   ⌃⌥⌘. stop   ⌃⌥⌘P pause"];
    keys.frame = NSMakeRect(16, 292, 348, 18);
    keys.font = [NSFont systemFontOfSize:11];
    [content addSubview:keys];

    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(16, 12, 348, 274)];
    scroll.hasVerticalScroller = YES;
    stepsView = [[NSTextView alloc] initWithFrame:scroll.bounds];
    stepsView.editable = NO;
    stepsView.font = [NSFont systemFontOfSize:13];
    stepsView.string = @"No steps yet.\n";
    scroll.documentView = stepsView;
    [content addSubview:scroll];
    for (NSView *sub in content.subviews) sub.translatesAutoresizingMaskIntoConstraints = YES;
    stepsView.translatesAutoresizingMaskIntoConstraints = YES;

    installHotkeys();
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ readStdin(); });
}
- (void)pause:(id)sender { onPause(sender); }
- (void)note:(id)sender { onNote(sender); }
- (void)check:(id)sender { onCheck(sender); }
- (void)discard:(id)sender { onDiscard(sender); }
- (void)openSettings:(id)sender { onOpenSettings(sender); }
- (void)showWindow:(id)sender { onShowWindow(sender); }
@end

int main(void) {
    outLock = [[NSLock alloc] init];
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        BarApp *delegate = [BarApp new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
