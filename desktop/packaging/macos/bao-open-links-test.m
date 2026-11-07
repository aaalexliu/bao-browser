#import "bao-window.m"
#import <objc/runtime.h>
#include <assert.h>
#include <stdio.h>

static NSMutableArray<NSURLRequest *> *requests;

@interface LinkTestSession : NSObject
@end
@implementation LinkTestSession
- (id)dataTaskWithRequest:(NSURLRequest *)request completionHandler:(void (^)(NSData *, NSURLResponse *, NSError *))handler {
    (void)handler;
    [requests addObject:request];
    return nil;
}
@end

static id link_test_session(id self, SEL cmd) {
    (void)self;
    (void)cmd;
    return [LinkTestSession new];
}

@interface LinkTestWindow : BaoWindow
@property(nonatomic) NSUInteger presentations;
@end
@implementation LinkTestWindow
- (void)showWindow:(id)sender {
    (void)sender;
    self.presentations++;
}
@end

int main(void) {
    @autoreleasepool {
        requests = [NSMutableArray new];
        Method method = class_getClassMethod(NSURLSession.class, @selector(sharedSession));
        IMP original = method_setImplementation(method, (IMP)link_test_session);
        LinkTestWindow *owner = [LinkTestWindow new];
        owner.serverURL = [NSURL URLWithString:@"http://127.0.0.1:47879/"];
        NSApplication *app = (NSApplication *)[NSObject new];
        [owner application:app openURLs:@[[NSURL URLWithString:@"bao://import/not-local"]]];
        assert(owner.presentations == 1);
        assert(requests.count == 0);

        [owner application:app openURLs:@[
            [NSURL URLWithString:@"bao://receipt/run-capture"],
            [NSURL URLWithString:@"bao://import/another-listing"],
            [NSURL URLWithString:@"bao://workflow/groceries"],
            [NSURL URLWithString:@"BAO://IMPORT/uppercase-listing"],
            [NSURL URLWithString:@"bao://run/groceries"],
            [NSURL URLWithString:@"https://example.test/import/listing"],
        ]];
        assert(owner.presentations == 3);
        assert(requests.count == 3);
        NSArray<NSString *> *links = @[@"bao://receipt/run-capture", @"bao://workflow/groceries", @"bao://run/groceries"];
        for (NSUInteger i = 0; i < requests.count; i++) {
            NSURLRequest *request = requests[i];
            assert([request.HTTPMethod isEqualToString:@"POST"]);
            assert([request.URL.absoluteString isEqualToString:@"http://127.0.0.1:47879/api/open"]);
            assert([[request valueForHTTPHeaderField:@"Content-Type"] isEqualToString:@"application/json"]);
            NSDictionary *body = [NSJSONSerialization JSONObjectWithData:request.HTTPBody options:0 error:NULL];
            assert([body isEqual:@{@"link": links[i]}]);
        }
        method_setImplementation(method, original);
        puts("ok native URL import exclusion and receipt, workflow, run forwarding");
    }
    return 0;
}
