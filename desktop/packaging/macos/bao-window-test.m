#import "bao-window.m"
#import <objc/runtime.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static WKWebsiteDataStore *test_store(id self, SEL cmd) {
    (void)self;
    (void)cmd;
    return WKWebsiteDataStore.nonPersistentDataStore;
}

@interface TestAction : NSObject
@property(nonatomic, strong) NSURL *url;
@property(nonatomic) WKNavigationType kind;
@property(nonatomic) BOOL download;
@property(nonatomic) BOOL newWindow;
@end
@implementation TestAction
- (NSURLRequest *)request { return [NSURLRequest requestWithURL:self.url]; }
- (WKNavigationType)navigationType { return self.kind; }
- (BOOL)shouldPerformDownload { return self.download; }
- (WKFrameInfo *)targetFrame { return self.newWindow ? nil : (WKFrameInfo *)self; }
@end

static NSURL *opened;
static BOOL open_external(id self, SEL cmd, NSURL *url) {
    (void)self;
    (void)cmd;
    opened = url;
    return YES;
}

static WKNavigationActionPolicy policy(BaoWindow *owner, NSString *url, WKNavigationType kind, BOOL download) {
    TestAction *action = [TestAction new];
    action.url = [NSURL URLWithString:url];
    action.kind = kind;
    action.download = download;
    __block int calls = 0;
    __block WKNavigationActionPolicy result = WKNavigationActionPolicyCancel;
    [owner webView:owner.webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:^(WKNavigationActionPolicy value) {
        calls++;
        result = value;
    }];
    assert(calls == 1);
    return result;
}

int main(void) {
    @autoreleasepool {
        // No persistent WebKit state or external app launch in this test.
        method_setImplementation(class_getClassMethod(WKWebsiteDataStore.class, @selector(defaultDataStore)), (IMP)test_store);
        method_setImplementation(class_getInstanceMethod(NSWorkspace.class, @selector(openURL:)), (IMP)open_external);
        NSApplication *app = NSApplication.sharedApplication;
        BaoWindow *owner = [[BaoWindow alloc] initWithURL:[NSURL URLWithString:@"http://127.0.0.1:47879/"] serverPid:-1];
        assert([owner.window.title isEqualToString:@"Bao"]);
        assert(!owner.window.releasedWhenClosed);
        assert(!owner.webView.configuration.websiteDataStore.persistent);
        assert([owner isLocalURL:[NSURL URLWithString:@"http://127.0.0.1:47879/?screen=settings"]]);
        for (NSString *url in @[@"http://127.0.0.1:4787/", @"http://localhost:47879/", @"https://127.0.0.1:47879/",
                                @"http://127.0.0.1:47879.evil.test/", @"http://user@127.0.0.1:47879/", @"file:///tmp/test"]) {
            assert(![owner isLocalURL:[NSURL URLWithString:url]]);
        }
        assert(policy(owner, @"http://127.0.0.1:47879/", WKNavigationTypeOther, NO) == WKNavigationActionPolicyAllow);
        assert(policy(owner, @"https://example.com/", WKNavigationTypeOther, NO) == WKNavigationActionPolicyCancel);
        assert(!opened);
        assert(policy(owner, @"https://example.com/", WKNavigationTypeLinkActivated, NO) == WKNavigationActionPolicyCancel);
        assert([opened.absoluteString isEqualToString:@"https://example.com/"]);
        opened = nil;
        assert(policy(owner, @"file:///tmp/test", WKNavigationTypeLinkActivated, NO) == WKNavigationActionPolicyCancel);
        assert(!opened);
        assert(policy(owner, @"blob:http://127.0.0.1:47879/workflow", WKNavigationTypeOther, YES) == WKNavigationActionPolicyDownload);
        assert(policy(owner, @"blob:https://example.com/workflow", WKNavigationTypeOther, YES) == WKNavigationActionPolicyCancel);
        install_menus(owner);
        assert([app.mainMenu.itemArray[0].submenu.itemArray.lastObject.title isEqualToString:@"Quit Bao"]);
        assert([app.mainMenu.itemArray[1].submenu.title isEqualToString:@"Edit"]);
        [owner showWindow:nil];
        assert(owner.window.visible);
        [owner.window close];
        assert(!owner.window.visible);
        [owner applicationShouldHandleReopen:app hasVisibleWindows:NO];
        assert(owner.window.visible);
        [owner.window orderOut:nil];

        char temp[] = "/tmp/bao-window-download-XXXXXX";
        assert(mkdtemp(temp));
        NSURL *root = [NSURL fileURLWithPath:[NSString stringWithUTF8String:temp] isDirectory:YES];
        NSURL *destination = [root URLByAppendingPathComponent:@"workflow.json"];
        NSFileManager *files = NSFileManager.defaultManager;
        WKDownload *download = (WKDownload *)[NSObject new];
        [@"original" writeToURL:destination atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        BaoDownload *pending = [owner prepareDownloadAtURL:destination error:NULL];
        assert(pending && pending.replaceExisting && ![files fileExistsAtPath:pending.file.path]);
        [@"partial" writeToURL:pending.file atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        [owner.downloads setObject:pending forKey:download];
        [owner download:download didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCancelled userInfo:nil] resumeData:nil];
        assert([[NSString stringWithContentsOfURL:destination encoding:NSUTF8StringEncoding error:NULL] isEqual:@"original"]);
        assert(![files fileExistsAtPath:pending.directory.path]);
        pending = [owner prepareDownloadAtURL:destination error:NULL];
        [@"complete" writeToURL:pending.file atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        [owner.downloads setObject:pending forKey:download];
        [owner downloadDidFinish:download];
        assert([[NSString stringWithContentsOfURL:destination encoding:NSUTF8StringEncoding error:NULL] isEqual:@"complete"]);
        assert(![owner.downloads objectForKey:download]);
        [files removeItemAtURL:destination error:NULL];
        pending = [owner prepareDownloadAtURL:destination error:NULL];
        assert(pending && !pending.replaceExisting);
        [@"new" writeToURL:pending.file atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        [owner.downloads setObject:pending forKey:download];
        [owner downloadDidFinish:download];
        assert([[NSString stringWithContentsOfURL:destination encoding:NSUTF8StringEncoding error:NULL] isEqual:@"new"]);
        [files removeItemAtURL:root error:NULL];

        pid_t child = fork();
        assert(child >= 0);
        if (child == 0) { for (;;) pause(); }
        owner.serverPid = child;
        [owner stopServer];
        assert(waitpid(child, NULL, WNOHANG) == -1 && errno == ECHILD);
        [owner stopServer];
        // A stuck server must not keep Quit waiting forever.
        int ready[2];
        assert(pipe(ready) == 0);
        child = fork();
        assert(child >= 0);
        if (child == 0) {
            close(ready[0]);
            signal(SIGTERM, SIG_IGN);
            assert(write(ready[1], "x", 1) == 1);
            for (;;) pause();
        }
        close(ready[1]);
        char ch;
        assert(read(ready[0], &ch, 1) == 1);
        close(ready[0]);
        owner.serverPid = child;
        [owner stopServer];
        assert(waitpid(child, NULL, WNOHANG) == -1 && errno == ECHILD);
        puts("ok native window policy, reopen, menus, downloads and server cleanup");
    }
    return 0;
}
