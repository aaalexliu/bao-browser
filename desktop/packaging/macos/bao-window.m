#import "bao-window.h"
#import "bao-notify.h"
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#include <errno.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

@interface BaoTitlebar : NSView
@end
@implementation BaoTitlebar
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    (void)event;
    return YES;
}
- (void)mouseDown:(NSEvent *)event {
    if (event.clickCount == 2) {
        NSString *action = [NSUserDefaults.standardUserDefaults stringForKey:@"AppleActionOnDoubleClick"];
        if ([action isEqualToString:@"Minimize"]) [self.window miniaturize:nil];
        else if (![action isEqualToString:@"None"]) [self.window zoom:nil];
    } else [self.window performWindowDragWithEvent:event];
}
@end

@interface BaoDownload : NSObject
@property(nonatomic, strong) NSURL *destination;
@property(nonatomic, strong) NSURL *directory;
@property(nonatomic, strong) NSURL *file;
@property(nonatomic) BOOL replaceExisting;
@end
@implementation BaoDownload
@end

@interface BaoWindow : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSURL *serverURL;
@property(nonatomic) pid_t serverPid;
@property(nonatomic, strong) NSMapTable<WKDownload *, BaoDownload *> *downloads;
- (instancetype)initWithURL:(NSURL *)url serverPid:(pid_t)pid;
- (void)showWindow:(id)sender;
- (void)stopServer;
@end

@implementation BaoWindow

- (instancetype)initWithURL:(NSURL *)url serverPid:(pid_t)pid {
    self = [super init];
    if (!self) return nil;
    _serverURL = url;
    _serverPid = pid;
    _downloads = [NSMapTable strongToStrongObjectsMapTable];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    // Persist UI preferences in Bao's WebKit store, not Safari or a task profile.
    config.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
    [config.userContentController addUserScript:[[WKUserScript alloc]
        initWithSource:@"document.documentElement.dataset.baoNative = 'true'"
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    _webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1200, 800) configuration:config];
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    _window = [[NSWindow alloc] initWithContentRect:_webView.frame
                                        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                  NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                                                  NSWindowStyleMaskFullSizeContentView
                                          backing:NSBackingStoreBuffered defer:NO];
    _window.delegate = self;
    _window.title = @"Bao";
    _window.titleVisibility = NSWindowTitleHidden;
    _window.titlebarAppearsTransparent = YES;
    _window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
    _window.minSize = NSMakeSize(720, 600);
    _window.releasedWhenClosed = NO;
    NSView *content = [[NSView alloc] initWithFrame:_webView.frame];
    _webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [content addSubview:_webView];
    BaoTitlebar *titlebar = [[BaoTitlebar alloc] initWithFrame:NSMakeRect(0, content.bounds.size.height - 52, 212, 52)];
    titlebar.autoresizingMask = NSViewMinYMargin;
    [content addSubview:titlebar];
    _window.contentView = content;
    [_window center];
    [_webView loadRequest:[NSURLRequest requestWithURL:url]];
    return self;
}

- (void)positionWindowButtons {
    if (self.window.styleMask & NSWindowStyleMaskFullScreen) return;
    NSUInteger index = 0;
    for (NSNumber *kind in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
        NSButton *button = [self.window standardWindowButton:kind.unsignedIntegerValue];
        NSUInteger position = index++;
        if (button.window != self.window) continue;
        NSPoint center = [button.superview convertPoint:NSMakePoint(24 + position * 20, self.window.contentView.bounds.size.height - 24)
                                              fromView:self.window.contentView];
        [button setFrameOrigin:NSMakePoint(center.x - button.frame.size.width / 2, center.y - button.frame.size.height / 2)];
    }
}

- (void)windowDidResize:(NSNotification *)notification {
    (void)notification;
    [self positionWindowButtons];
}

- (void)windowDidExitFullScreen:(NSNotification *)notification {
    (void)notification;
    [self positionWindowButtons];
}

- (void)showWindow:(id)sender {
    (void)sender;
    [self.window deminiaturize:nil];
    [self.window makeKeyAndOrderFront:nil];
    [self.window displayIfNeeded];
    [self positionWindowButtons];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)visible {
    (void)app;
    (void)visible;
    [self showWindow:nil];
    return NO;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    (void)notification;
    [self stopServer];
    bao_notify_stop();
}

- (void)stopServer {
    if (self.serverPid <= 0) return;
    pid_t pid = self.serverPid;
    self.serverPid = -1;
    kill(pid, SIGTERM);
    for (int i = 0; i < 40; i++) {
        pid_t done = waitpid(pid, NULL, WNOHANG);
        if (done == pid || (done < 0 && errno != EINTR)) return;
        usleep(50000);
    }
    kill(pid, SIGKILL);
    while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {}
}

- (BOOL)isLocalURL:(NSURL *)url {
    return url && [url.scheme isEqualToString:self.serverURL.scheme] &&
        [url.host isEqualToString:self.serverURL.host] && [url.port isEqual:self.serverURL.port] &&
        !url.user && !url.password;
}

- (BOOL)isLocalBlob:(NSURL *)url {
    return [url.scheme isEqualToString:@"blob"] &&
        [self isLocalURL:[NSURL URLWithString:[url.absoluteString substringFromIndex:5]]];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
       decisionHandler:(void (^)(WKNavigationActionPolicy))decide {
    NSURL *url = action.request.URL;
    BOOL local = [self isLocalURL:url];
    if (action.shouldPerformDownload && (local || [self isLocalBlob:url])) {
        decide(WKNavigationActionPolicyDownload);
        return;
    }
    if (local) {
        if (!action.targetFrame) {
            [webView loadRequest:action.request];
            decide(WKNavigationActionPolicyCancel);
        } else {
            decide(WKNavigationActionPolicyAllow);
        }
        return;
    }
    // A redirect or script must not open another app without a clicked link.
    if (action.navigationType == WKNavigationTypeLinkActivated &&
        [@[@"https", @"http", @"mailto", @"x-apple.systempreferences"] containsObject:url.scheme.lowercaseString]) {
        [NSWorkspace.sharedWorkspace openURL:url];
    }
    decide(WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response
       decisionHandler:(void (^)(WKNavigationResponsePolicy))decide {
    (void)webView;
    decide(response.canShowMIMEType ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyDownload);
}

- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download {
    (void)webView;
    (void)action;
    download.delegate = self;
}

- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)response didBecomeDownload:(WKDownload *)download {
    (void)webView;
    (void)response;
    download.delegate = self;
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
       suggestedFilename:(NSString *)filename completionHandler:(void (^)(NSURL *))complete {
    (void)response;
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = filename.lastPathComponent;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        if (result != NSModalResponseOK) { complete(nil); return; }
        NSError *error = nil;
        BaoDownload *file = [self prepareDownloadAtURL:panel.URL error:&error];
        if (!file) { complete(nil); [self showFileError:error recovery:nil]; return; }
        [self.downloads setObject:file forKey:download];
        complete(file.file);
    }];
}

- (BaoDownload *)prepareDownloadAtURL:(NSURL *)destination error:(NSError **)error {
    NSFileManager *files = NSFileManager.defaultManager;
    NSURL *directory = [files URLForDirectory:NSItemReplacementDirectory inDomain:NSUserDomainMask
                           appropriateForURL:destination create:YES error:error];
    if (!directory) return nil;
    BaoDownload *file = [BaoDownload new];
    file.destination = destination;
    file.directory = directory;
    file.file = [directory URLByAppendingPathComponent:@"download"];
    file.replaceExisting = [files fileExistsAtPath:destination.path];
    return file;
}

- (void)downloadDidFinish:(WKDownload *)download {
    BaoDownload *file = [self.downloads objectForKey:download];
    if (!file) return;
    NSFileManager *files = NSFileManager.defaultManager;
    NSError *error = nil;
    // WebKit requires a new file. Replace the chosen file only after all bytes arrive.
    BOOL saved = file.replaceExisting
        ? [files replaceItemAtURL:file.destination withItemAtURL:file.file backupItemName:nil options:0 resultingItemURL:NULL error:&error]
        : [files moveItemAtURL:file.file toURL:file.destination error:&error];
    if (saved) [files removeItemAtURL:file.directory error:NULL];
    else [self showFileError:error recovery:file.file];
    [self.downloads removeObjectForKey:download];
}

- (void)showFileError:(NSError *)error recovery:(NSURL *)file {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Bao could not save the file";
    alert.informativeText = file
        ? [NSString stringWithFormat:@"%@\n\nThe downloaded file is at %@", error.localizedDescription, file.path]
        : error.localizedDescription;
    [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    (void)resumeData;
    BaoDownload *file = [self.downloads objectForKey:download];
    if (file) [NSFileManager.defaultManager removeItemAtURL:file.directory error:NULL];
    [self.downloads removeObjectForKey:download];
    if (error.code != NSURLErrorCancelled) [self showFileError:error recovery:nil];
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
       initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))complete {
    (void)webView;
    (void)frame;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseDirectories = parameters.allowsDirectories;
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        complete(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
       initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))complete {
    (void)webView;
    (void)frame;
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Bao";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        (void)result;
        complete();
    }];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
       initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))complete {
    (void)webView;
    (void)frame;
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Bao";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        complete(result == NSAlertFirstButtonReturn);
    }];
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
       defaultText:(NSString *)text initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))complete {
    (void)webView;
    (void)frame;
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Bao";
    alert.informativeText = prompt;
    NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
    input.stringValue = text ?: @"";
    alert.accessoryView = input;
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    [alert.window setInitialFirstResponder:input];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        complete(result == NSAlertFirstButtonReturn ? input.stringValue : nil);
    }];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [webView reload];
}

@end

static void install_menus(BaoWindow *owner) {
    NSMenu *bar = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    [bar addItem:appItem];
    NSMenu *app = [[NSMenu alloc] initWithTitle:@"Bao"];
    [app addItemWithTitle:@"About Bao" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [app addItem:NSMenuItem.separatorItem];
    [app addItemWithTitle:@"Hide Bao" action:@selector(hide:) keyEquivalent:@"h"];
    NSMenuItem *others = [app addItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
    others.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
    [app addItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) keyEquivalent:@""];
    [app addItem:NSMenuItem.separatorItem];
    [app addItemWithTitle:@"Quit Bao" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = app;

    NSMenuItem *editItem = [NSMenuItem new];
    [bar addItem:editItem];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
    [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    NSMenuItem *redo = [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z"];
    redo.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [edit addItem:NSMenuItem.separatorItem];
    [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = edit;

    NSMenuItem *windowItem = [NSMenuItem new];
    [bar addItem:windowItem];
    NSMenu *window = [[NSMenu alloc] initWithTitle:@"Window"];
    [window addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [window addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
    [window addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
    NSMenuItem *show = [window addItemWithTitle:@"Show Bao" action:@selector(showWindow:) keyEquivalent:@"0"];
    show.target = owner;
    windowItem.submenu = window;
    NSApp.mainMenu = bar;
    NSApp.windowsMenu = window;
}

int bao_window_run(const char *url, int node_pid) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        BaoWindow *owner = [[BaoWindow alloc] initWithURL:[NSURL URLWithString:[NSString stringWithUTF8String:url]] serverPid:node_pid];
        app.delegate = owner;
        install_menus(owner);
        bao_notify_start();
        [owner showWindow:nil];

        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(timer, ^{
            if (owner.serverPid <= 0) return;
            int status = 0;
            pid_t done = waitpid(owner.serverPid, &status, WNOHANG);
            if (done == 0 || (done < 0 && errno == EINTR)) return;
            owner.serverPid = -1;
            bao_show_alert("Bao stopped", "Bao's local server stopped. Quit Bao and open it again.");
            [app terminate:nil];
        });
        dispatch_resume(timer);
        signal(SIGTERM, SIG_IGN);
        signal(SIGINT, SIG_IGN);
        dispatch_source_t term = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
        dispatch_source_t interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(term, ^{ [app terminate:nil]; });
        dispatch_source_set_event_handler(interrupt, ^{ [app terminate:nil]; });
        dispatch_resume(term);
        dispatch_resume(interrupt);
        [app run];
        dispatch_source_cancel(timer);
        dispatch_source_cancel(term);
        dispatch_source_cancel(interrupt);
        [owner stopServer];
        bao_notify_stop();
        return 0;
    }
}
