#import "bao-notify.h"

#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <sys/stat.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static void raise_waiting_window(void);
static int listen_fd = -1;
static int product_browser_pid = -1;
static char sock_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
static BOOL auth_requested = NO;
static NSString *const kCategory = @"bao.act";
static NSString *const kShowAction = @"show-window";

@interface BaoNotify : NSObject <UNUserNotificationCenterDelegate, NSApplicationDelegate>
@end

static BaoNotify *notify_owner;

@implementation BaoNotify

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    (void)center;
    (void)notification;
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    (void)center;
    if ([response.actionIdentifier isEqualToString:kShowAction] ||
        [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        raise_waiting_window();
    }
    completionHandler();
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    (void)sender;
    (void)flag;
    bao_focus_pid(product_browser_pid);
    return NO;
}

@end

void bao_show_alert(const char *title, const char *body) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app activateIgnoringOtherApps:YES];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleInformational;
        alert.messageText = title ? [NSString stringWithUTF8String:title] : @"Bao";
        alert.informativeText = body ? [NSString stringWithUTF8String:body] : @"";
        [alert addButtonWithTitle:@"OK"];
        [alert runModal];
    }
}

void bao_focus_pid(int pid) {
    if (pid <= 0) return;
    @autoreleasepool {
        NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        if (!running) return;
        [running unhide];
        [running activateWithOptions:NSApplicationActivateIgnoringOtherApps | NSApplicationActivateAllWindows];
    }
}

static NSString *auth_name(UNAuthorizationStatus status) {
    switch (status) {
    case UNAuthorizationStatusNotDetermined: return @"notDetermined";
    case UNAuthorizationStatusDenied: return @"denied";
    case UNAuthorizationStatusAuthorized: return @"authorized";
    case UNAuthorizationStatusProvisional: return @"provisional";
    default:
        return @"unknown";
    }
}

static NSString *badge_label(void) {
    return [NSApp dockTile].badgeLabel ?: @"";
}

static const char *utf8(NSString *text) {
    const char *bytes = text.UTF8String;
    return bytes ? bytes : "";
}

static void log_delivered(NSArray<UNNotification *> *notes) {
    fprintf(stderr, "bao notify delivered count=%lu\n", (unsigned long)notes.count);
    for (UNNotification *note in notes) {
        NSString *title = note.request.content.title ?: @"";
        NSString *body = note.request.content.body ?: @"";
        body = [body stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
        fprintf(stderr, "bao notify delivered title=%s body=%s\n", utf8(title), utf8(body));
    }
    fflush(stderr);
}

static void raise_waiting_window(void) {
    const char *port = getenv("BAO_PORT");
    if (!port || !port[0]) port = "4787";
    NSString *urlText = [NSString stringWithFormat:@"http://127.0.0.1:%s/api/replay/show", port];
    NSURL *url = [NSURL URLWithString:urlText];
    if (!url) return;
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.HTTPMethod = @"POST";
    req.HTTPBody = [NSData data];
    req.timeoutInterval = 3;
    [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        (void)data;
        (void)response;
        fprintf(stderr, "bao show window notify %s\n", error ? (error.localizedDescription.UTF8String ?: "error") : "ok");
        fflush(stderr);
    }] resume];
}

static NSString *clip_text(id value, NSUInteger maxLen, NSString *fallback) {
    NSString *text = [value isKindOfClass:[NSString class]] ? (NSString *)value : (fallback ?: @"");
    text = [[text stringByReplacingOccurrencesOfString:@"\n" withString:@" "] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (text.length > maxLen) text = [text substringToIndex:maxLen];
    return text ?: @"";
}

static void set_badge(NSString *label, NSString *tip) {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSDockTile *tile = [NSApp dockTile];
    [tile setBadgeLabel:label.length ? label : nil];
    NSString *text = tip ?: @"";
    [NSApp setAccessibilityHelp:text.length ? text : nil];
    [tile display];
}

static void write_reply(int fd, NSDictionary *payload) {
    NSMutableDictionary *body = [payload mutableCopy] ?: [NSMutableDictionary dictionary];
    if (!body[@"bundleId"]) body[@"bundleId"] = [NSBundle mainBundle].bundleIdentifier ?: @"";
    NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    if (!data) data = [@"{\"ok\":false,\"error\":\"encode\"}\n" dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    const char *bytes = line.bytes;
    size_t left = line.length;
    while (left > 0) {
        ssize_t n = write(fd, bytes, left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        bytes += n;
        left -= (size_t)n;
    }
    close(fd);
}

static void install_category(UNUserNotificationCenter *center) {
    UNNotificationAction *open = [UNNotificationAction actionWithIdentifier:kShowAction
                                                                      title:@"Show window"
                                                                    options:UNNotificationActionOptionForeground];
    UNNotificationCategory *category = [UNNotificationCategory categoryWithIdentifier:kCategory
                                                                              actions:@[open]
                                                                    intentIdentifiers:@[]
                                                                              options:UNNotificationCategoryOptionNone];
    [center setNotificationCategories:[NSSet setWithObject:category]];
}

static void reply_delivered(int fd, NSString *identifier, NSString *authorization, NSString *badge, NSString *title, NSString *body, NSString *tooltip) {
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notes) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSMutableArray *titles = [NSMutableArray array];
            NSMutableArray *bodies = [NSMutableArray array];
            BOOL found = NO;
            log_delivered(notes);
            for (UNNotification *note in notes) {
                [titles addObject:note.request.content.title ?: @""];
                [bodies addObject:note.request.content.body ?: @""];
                if ([note.request.identifier isEqualToString:identifier]) found = YES;
            }
            write_reply(fd, @{
                @"ok": @YES,
                @"authorization": authorization,
                @"prompt": @NO,
                @"delivered": @(found),
                @"identifier": identifier ?: @"",
                @"titles": titles,
                @"bodies": bodies,
                @"badge": badge ?: @"",
                @"title": title ?: @"",
                @"body": body ?: @"",
                @"tooltip": tooltip ?: @"",
            });
        });
    }];
}

static void post_act(int fd, NSString *title, NSString *body, NSString *tooltip, NSString *authorization, NSString *badge) {
    fprintf(stderr, "bao notify text title=%s body=%s tooltip=%s\n", utf8(title), utf8(body), utf8(tooltip));
    fflush(stderr);
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    install_category(center);
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = title;
    content.body = body;
    content.categoryIdentifier = kCategory;
    NSString *identifier = [NSUUID UUID].UUIDString;
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
    [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        if (error) {
            NSString *message = error.localizedDescription ?: @"add failed";
            dispatch_async(dispatch_get_main_queue(), ^{
                write_reply(fd, @{
                    @"ok": @NO,
                    @"authorization": authorization,
                    @"prompt": @NO,
                    @"delivered": @NO,
                    @"badge": badge_label(),
                    @"title": title ?: @"",
                    @"body": body ?: @"",
                    @"tooltip": tooltip ?: @"",
                    @"error": message,
                });
            });
            return;
        }
        reply_delivered(fd, identifier, authorization, badge, title, body, tooltip);
    }];
}

static NSString *badge_on_main(NSString *label, NSString *tip) {
    __block NSString *shown = @"";
    __block NSString *help = @"";
    void (^apply)(void) = ^{
        set_badge(label, tip);
        shown = badge_label();
        help = NSApp.accessibilityHelp ?: @"";
    };
    if ([NSThread isMainThread]) apply();
    else dispatch_sync(dispatch_get_main_queue(), apply);
    fprintf(stderr, "bao notify badgeLabel=%s\n", utf8(shown));
    fprintf(stderr, "bao notify tooltip=%s\n", utf8(help));
    fflush(stderr);
    return shown;
}

/* UNUserNotificationCenter callbacks deadlock if they are started on the main thread. */
static void handle_message(int fd, NSDictionary *msg) {
    NSString *cmd = [msg[@"cmd"] isKindOfClass:[NSString class]] ? msg[@"cmd"] : @"";
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    dispatch_async(dispatch_get_main_queue(), ^{
        center.delegate = notify_owner;
    });
    if ([cmd isEqualToString:@"clear"]) {
        NSString *badge = badge_on_main(nil, @"");
        [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notes) {
            NSMutableArray *ids = [NSMutableArray array];
            for (UNNotification *note in notes) {
                if ([note.request.content.categoryIdentifier isEqualToString:kCategory]) {
                    [ids addObject:note.request.identifier];
                }
            }
            if (ids.count) [center removeDeliveredNotificationsWithIdentifiers:ids];
            write_reply(fd, @{@"ok": @YES, @"badge": badge, @"cleared": @(ids.count)});
        }];
        return;
    }
    if (![cmd isEqualToString:@"act"]) {
        write_reply(fd, @{@"ok": @NO, @"error": @"unknown cmd"});
        return;
    }
    NSString *requested = [msg[@"badge"] isKindOfClass:[NSString class]] ? msg[@"badge"] : @"!";
    if (requested.length > 4) requested = [requested substringToIndex:4];
    NSString *title = clip_text(msg[@"title"], 240, @"You need to act");
    NSString *body = clip_text(msg[@"body"], 240, title);
    NSString *tooltip = clip_text(msg[@"tooltip"], 240, title);
    NSString *badge = badge_on_main(requested, tooltip);
    fprintf(stderr, "bao notify text title=%s body=%s tooltip=%s\n", utf8(title), utf8(body), utf8(tooltip));
    fprintf(stderr, "bao notify settings\n");
    fflush(stderr);
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        UNAuthorizationStatus status = settings.authorizationStatus;
        NSString *name = auth_name(status);
        fprintf(stderr, "bao notify authorization %s\n", name.UTF8String);
        if (status == UNAuthorizationStatusNotDetermined) {
            if (!auth_requested) {
                auth_requested = YES;
                dispatch_async(dispatch_get_main_queue(), ^{
                    [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                                          completionHandler:^(BOOL granted, NSError *error) {
                        fprintf(stderr, "bao notify prompt finished granted %d\n", granted ? 1 : 0);
                        if (error) fprintf(stderr, "bao notify prompt error %s\n", error.localizedDescription.UTF8String ?: "");
                        fflush(stderr);
                    }];
                });
            }
            write_reply(fd, @{
                @"ok": @YES,
                @"authorization": name,
                @"prompt": @YES,
                @"delivered": @NO,
                @"badge": badge,
                @"title": title,
                @"body": body,
                @"tooltip": tooltip,
            });
            return;
        }
        if (status != UNAuthorizationStatusAuthorized && status != UNAuthorizationStatusProvisional) {
            [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notes) {
                NSMutableArray *titles = [NSMutableArray array];
                NSMutableArray *bodies = [NSMutableArray array];
                log_delivered(notes);
                for (UNNotification *note in notes) {
                    [titles addObject:note.request.content.title ?: @""];
                    [bodies addObject:note.request.content.body ?: @""];
                }
                write_reply(fd, @{
                    @"ok": @YES,
                    @"authorization": name,
                    @"prompt": @NO,
                    @"delivered": @NO,
                    @"titles": titles,
                    @"bodies": bodies,
                    @"badge": badge,
                    @"title": title,
                    @"body": body,
                    @"tooltip": tooltip,
                });
            }];
            return;
        }
        post_act(fd, title, body, tooltip, name, badge);
    }];
}

static void *accept_loop(void *unused) {
    (void)unused;
    for (;;) {
        int fd = accept(listen_fd, NULL, NULL);
        if (fd < 0) {
            if (errno == EINTR) continue;
            break;
        }
        fprintf(stderr, "bao notify accept\n");
        fflush(stderr);
        char buf[4096];
        size_t used = 0;
        while (used + 1 < sizeof buf) {
            ssize_t n = read(fd, buf + used, sizeof buf - 1 - used);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            used += (size_t)n;
            if (memchr(buf, '\n', used)) break;
        }
        buf[used] = 0;
        char *nl = memchr(buf, '\n', used);
        if (nl) *nl = 0;
        @autoreleasepool {
            NSData *data = [NSData dataWithBytes:buf length:strlen(buf)];
            id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
            if (![parsed isKindOfClass:[NSDictionary class]]) {
                write_reply(fd, @{@"ok": @NO, @"error": @"bad json"});
                continue;
            }
            handle_message(fd, parsed);
        }
    }
    return NULL;
}

int bao_notify_prepare(const char *path) {
    if (!path || !path[0] || strlen(path) >= sizeof sock_path) return -1;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    int flags = fcntl(fd, F_GETFD);
    if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof addr.sun_path, "%s", path);
    unlink(path);
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
        close(fd);
        return -1;
    }
    chmod(path, 0600);
    if (listen(fd, 8) != 0) {
        close(fd);
        unlink(path);
        return -1;
    }
    listen_fd = fd;
    snprintf(sock_path, sizeof sock_path, "%s", path);
    return 0;
}

int bao_notify_run(int browser_pid, int node_pid) {
    @autoreleasepool {
        notify_owner = [BaoNotify new];
        product_browser_pid = browser_pid;
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app setDelegate:notify_owner];
        dispatch_async(dispatch_get_main_queue(), ^{
            bao_focus_pid(browser_pid);
        });
        UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
        center.delegate = notify_owner;
        install_category(center);
        fprintf(stderr, "bao notify bundle %s\n", [NSBundle mainBundle].bundleIdentifier.UTF8String ?: "");

        if (listen_fd >= 0) {
            pthread_t thread;
            pthread_create(&thread, NULL, accept_loop, NULL);
            pthread_detach(thread);
        }

        __block int status = 0;
        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 400 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(timer, ^{
            if (browser_pid <= 0) {
                [app stop:nil];
                return;
            }
            int wait_status = 0;
            pid_t got = waitpid(browser_pid, &wait_status, WNOHANG);
            if (got == 0) return;
            status = wait_status;
            if (node_pid > 0) {
                kill(node_pid, SIGTERM);
                waitpid(node_pid, &wait_status, 0);
            }
            if (listen_fd >= 0) close(listen_fd);
            if (sock_path[0]) unlink(sock_path);
            [app stop:nil];
            NSEvent *kick = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                                location:NSMakePoint(0, 0)
                                           modifierFlags:0
                                               timestamp:0
                                            windowNumber:0
                                                 context:nil
                                                 subtype:0
                                                   data1:0
                                                   data2:0];
            [app postEvent:kick atStart:NO];
        });
        dispatch_resume(timer);
        [app run];
        return status;
    }
}
