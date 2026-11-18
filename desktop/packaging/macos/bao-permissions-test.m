/* Test entry for bao-permissions.m, which it includes to reach the guide view.
 *   bao-permissions-test         shows the permission window with both grants forced off,
 *                                so no TCC check runs. mac-launch.test.ts starts it twice.
 *   bao-permissions-test drag    presses and drags on the guide bar, away from the icon, and
 *                                prints what the bar hands to AppKit's drag session. */
#import "bao-permissions.m"

@interface BaoGuideProbe : BaoGuideView
@property(strong) NSArray<NSDraggingItem *> *started;
@end

@implementation BaoGuideProbe
- (NSDraggingSession *)beginDraggingSessionWithItems:(NSArray<NSDraggingItem *> *)items event:(NSEvent *)event source:(id<NSDraggingSource>)source {
  self.started = items;
  return nil;
}
@end

static NSEvent *mouse(NSEventType type, NSWindow *window, NSPoint at) {
  return [NSEvent mouseEventWithType:type location:at modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
}

/* Returns "<url> <frame>" for the drag a press at x=400 starts, or "none". */
static NSString *dragFrom(NSString *app, BOOL draggable) {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 520, 76) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  BaoGuideProbe *view = [[BaoGuideProbe alloc] initWithFrame:NSMakeRect(0, 0, 520, 76)];
  view.appPath = app;
  view.line = kDragLine;
  view.draggable = draggable;
  window.contentView = view;
  [view mouseDown:mouse(NSEventTypeLeftMouseDown, window, NSMakePoint(400, 38))];
  [view mouseDragged:mouse(NSEventTypeLeftMouseDragged, window, NSMakePoint(412, 44))];
  if (view.started.count != 1) return @"none";
  NSDraggingItem *item = view.started.firstObject;
  NSURL *url = (NSURL *)item.item;
  return [NSString stringWithFormat:@"%@ %@", url.path, NSStringFromRect(item.draggingFrame)];
}

int main(int argc, char *argv[]) {
  if (argc > 1 && strcmp(argv[1], "drag") == 0) {
    @autoreleasepool {
      [NSApplication sharedApplication];
      NSString *app = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"/Applications/Bao.app";
      printf("bar %s\n", dragFrom(app, YES).UTF8String);
      printf("files %s\n", dragFrom(app, NO).UTF8String);
    }
    return 0;
  }
  BaoPermissionsOpts opts = {0, 1, 0, 0, NULL};
  return bao_permissions_show(&opts);
}
