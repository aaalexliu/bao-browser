/* Bao's permission window. It runs in the disclaimed Bao copy, so macOS asks
 * about Bao (dev.bao.desktop), not BaoOSHelper and not the terminal. */

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dirent.h>
#import <dlfcn.h>
#import <errno.h>
#import <mach-o/dyld.h>
#import <stdio.h>
#import <string.h>
#import "bao-permissions.h"

static NSString *const kHeadless = @"No screen here, so Bao did not open its permission window. On this Mac, run bao setup.";
static NSString *const kAccessibilityURL = @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
static NSString *const kFilesURL = @"x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
static NSString *const kAccessibilityTitle = @"Device Control and Data Access";
static NSString *const kAccessibilityPurpose = @"Ticks Chrome's remote-debugging box and presses Chrome's Allow, so agents can use the Chrome you're signed in to.";
static NSString *const kFilesTitle = @"Google Chrome's data";
static NSString *const kFilesPurpose = @"Finds your running Chrome and its profiles, and copies a site's sign-in into Bao's own browser when you ask.";
static NSString *const kDragLine = @"Drag Bao into the list above, then turn it on";
static NSString *const kFilesLine = @"Under Bao, turn on Google Chrome";

static NSString *bundlePath(void) {
  char buf[4096];
  uint32_t size = sizeof buf;
  if (_NSGetExecutablePath(buf, &size) != 0) return NSBundle.mainBundle.bundlePath;
  NSString *exe = [NSString stringWithUTF8String:buf].stringByStandardizingPath;
  NSRange marker = [exe rangeOfString:@".app/Contents/MacOS/"];
  if (marker.location == NSNotFound) return exe;
  return [exe substringToIndex:marker.location + 4];
}

static NSString *chromeFolder(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Google/Chrome"];
}

static NSString *folderState(void) {
  const char *path = chromeFolder().fileSystemRepresentation;
  DIR *dir = opendir(path);
  if (dir) {
    closedir(dir);
    return @"allowed";
  }
  return errno == ENOENT ? @"missing" : @"denied";
}

static int windowServer(void) {
  if (NSScreen.screens.count == 0) return 0;
  void *cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY);
  int (*connection)(void) = cg ? dlsym(cg, "CGSMainConnectionID") : NULL;
  return connection && connection() != 0;
}

static int printCheck(void) {
  Boolean trusted = AXIsProcessTrusted();
  NSString *folder = folderState();
  printf("{\"accessibility\":%s,\"chromeFolder\":\"%s\"}\n", trusted ? "true" : "false", folder.UTF8String);
  fflush(stdout);
  return 0;
}

static CGFloat flipHeight(void) {
  for (NSScreen *screen in NSScreen.screens) {
    if (NSMinX(screen.frame) == 0 && NSMinY(screen.frame) == 0) return NSHeight(screen.frame);
  }
  return NSHeight(NSScreen.mainScreen.frame);
}

static NSRect settingsFrame(void) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!list) return NSZeroRect;
  NSRect found = NSZeroRect;
  CGFloat height = flipHeight();
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(list, i);
    NSString *owner = info[(__bridge NSString *)kCGWindowOwnerName];
    if (![owner isEqualToString:@"System Settings"] && ![owner isEqualToString:@"System Preferences"]) continue;
    NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
    CGFloat w = [bounds[@"Width"] doubleValue];
    CGFloat h = [bounds[@"Height"] doubleValue];
    if (w < 280 || h < 180) continue;
    CGFloat x = [bounds[@"X"] doubleValue];
    CGFloat y = [bounds[@"Y"] doubleValue];
    found = NSMakeRect(x, height - y - h, w, h);
    break;
  }
  CFRelease(list);
  return found;
}

static void drawBaoMark(NSRect rect, NSColor *ink) {
  NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(rect, 1, 1) xRadius:10 yRadius:10];
  [[NSColor colorWithCalibratedWhite:1 alpha:1] setFill];
  [path fill];
  [[NSColor colorWithCalibratedWhite:0.82 alpha:1] setStroke];
  path.lineWidth = 1;
  [path stroke];
  NSDictionary *attrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:13 weight:NSFontWeightBold],
    NSForegroundColorAttributeName: ink,
  };
  NSString *mark = @"Bao";
  NSSize size = [mark sizeWithAttributes:attrs];
  [mark drawAtPoint:NSMakePoint(NSMidX(rect) - size.width / 2, NSMidY(rect) - size.height / 2) withAttributes:attrs];
}

@interface BaoDragTile : NSView <NSDraggingSource>
@property(copy) NSString *appPath;
@property NSPoint down;
@property BOOL dragging;
@end

@implementation BaoDragTile
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}
- (void)mouseDown:(NSEvent *)event { self.down = event.locationInWindow; self.dragging = NO; }
- (void)mouseDragged:(NSEvent *)event {
  if (self.dragging || self.appPath.length == 0) return;
  NSPoint now = event.locationInWindow;
  if (fabs(now.x - self.down.x) < 3 && fabs(now.y - self.down.y) < 3) return;
  self.dragging = YES;
  NSURL *url = [NSURL fileURLWithPath:self.appPath];
  NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:url];
  item.draggingFrame = self.bounds;
  NSImage *icon = [[NSImage alloc] initWithSize:self.bounds.size];
  [icon lockFocus];
  drawBaoMark(NSMakeRect(0, 0, self.bounds.size.width, self.bounds.size.height), [NSColor colorWithCalibratedWhite:0.12 alpha:1]);
  [icon unlockFocus];
  item.imageComponentsProvider = ^NSArray<NSDraggingImageComponent *> *{
    NSDraggingImageComponent *component = [NSDraggingImageComponent draggingImageComponentWithKey:NSDraggingImageComponentIconKey];
    component.contents = icon;
    component.frame = self.bounds;
    return @[component];
  };
  [self beginDraggingSessionWithItems:@[item] event:event source:self];
}
- (void)drawRect:(NSRect)dirty {
  drawBaoMark(self.bounds, [NSColor colorWithCalibratedWhite:0.12 alpha:1]);
}
@end

@interface BaoGuideView : NSView
@property(copy) NSString *line;
@property BOOL showTile;
@end

@implementation BaoGuideView
- (BOOL)isOpaque { return YES; }
- (BOOL)dark {
  NSString *name = [self.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
  return [name isEqualToString:NSAppearanceNameDarkAqua];
}
- (void)drawRect:(NSRect)dirty {
  BOOL dark = [self dark];
  NSColor *bg = dark ? [NSColor colorWithCalibratedWhite:0.14 alpha:1] : [NSColor colorWithCalibratedWhite:0.96 alpha:1];
  NSColor *fg = dark ? NSColor.whiteColor : [NSColor colorWithCalibratedWhite:0.1 alpha:1];
  [bg setFill];
  NSRectFill(self.bounds);
  NSDictionary *arrowAttrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName: fg,
  };
  NSDictionary *textAttrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:14 weight:NSFontWeightMedium],
    NSForegroundColorAttributeName: fg,
  };
  CGFloat textX = 16;
  if (self.showTile) {
    drawBaoMark(NSMakeRect(16, 14, 48, 48), [NSColor colorWithCalibratedWhite:0.12 alpha:1]);
    textX = 76;
  }
  NSRect textRect = NSMakeRect(textX + 22, 16, NSWidth(self.bounds) - textX - 38, 44);
  [@"↑" drawAtPoint:NSMakePoint(textX, NSMidY(textRect) - 8) withAttributes:arrowAttrs];
  [self.line drawInRect:textRect withAttributes:textAttrs];
}
@end

@interface BaoCard : NSView
@property(strong) NSTextField *titleLabel;
@property(strong) NSTextField *purposeLabel;
@property(strong) NSButton *action;
@property(strong) NSTextField *allowed;
- (instancetype)initWithTitle:(NSString *)title purpose:(NSString *)purpose;
- (void)showAllowed:(BOOL)allowed button:(NSString *)button;
@end

@implementation BaoCard
- (instancetype)initWithTitle:(NSString *)title purpose:(NSString *)purpose {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  self.titleLabel = [NSTextField labelWithString:title];
  self.titleLabel.font = [NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
  self.titleLabel.textColor = NSColor.labelColor;
  self.purposeLabel = [NSTextField wrappingLabelWithString:purpose];
  self.purposeLabel.font = [NSFont systemFontOfSize:13];
  self.purposeLabel.textColor = NSColor.secondaryLabelColor;
  self.purposeLabel.maximumNumberOfLines = 3;
  self.action = [NSButton buttonWithTitle:@"Allow" target:nil action:NULL];
  self.action.bezelStyle = NSBezelStyleRounded;
  self.allowed = [NSTextField labelWithString:@"Allowed"];
  self.allowed.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  self.allowed.textColor = NSColor.systemGreenColor;
  self.allowed.hidden = YES;
  for (NSView *view in @[self.titleLabel, self.purposeLabel, self.action, self.allowed]) [self addSubview:view];
  return self;
}
- (CGFloat)textBlockHeightForWidth:(CGFloat)width {
  CGFloat textWidth = width - 16 - 96;
  NSSize title = [self.titleLabel.cell cellSizeForBounds:NSMakeRect(0, 0, textWidth, 80)];
  NSSize purpose = [self.purposeLabel.cell cellSizeForBounds:NSMakeRect(0, 0, textWidth, 240)];
  return ceil(title.height) + 6 + ceil(purpose.height);
}
- (CGFloat)fittedHeightForWidth:(CGFloat)width {
  return 16 + [self textBlockHeightForWidth:width] + 16;
}
- (void)layout {
  [super layout];
  NSRect bounds = self.bounds;
  CGFloat textWidth = NSWidth(bounds) - 16 - 96;
  NSSize title = [self.titleLabel.cell cellSizeForBounds:NSMakeRect(0, 0, textWidth, 80)];
  NSSize purpose = [self.purposeLabel.cell cellSizeForBounds:NSMakeRect(0, 0, textWidth, 240)];
  CGFloat titleH = ceil(title.height);
  CGFloat purposeH = ceil(purpose.height);
  self.titleLabel.frame = NSMakeRect(16, NSHeight(bounds) - 16 - titleH, textWidth, titleH);
  self.purposeLabel.frame = NSMakeRect(16, 16, textWidth, purposeH);
  CGFloat mid = 16 + (purposeH + 6 + titleH) / 2;
  self.action.frame = NSMakeRect(NSWidth(bounds) - 16 - 76, mid - 14, 76, 28);
  [self.allowed sizeToFit];
  self.allowed.frame = NSMakeRect(NSWidth(bounds) - 16 - NSWidth(self.allowed.frame), mid - NSHeight(self.allowed.frame) / 2, NSWidth(self.allowed.frame), NSHeight(self.allowed.frame));
}
- (void)showAllowed:(BOOL)on button:(NSString *)button {
  self.action.hidden = on;
  self.action.title = button;
  self.allowed.hidden = !on;
  self.needsDisplay = YES;
}
- (void)drawRect:(NSRect)dirty {
  NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 0.5, 0.5) xRadius:12 yRadius:12];
  [NSColor.controlBackgroundColor setFill];
  [path fill];
  [NSColor.separatorColor setStroke];
  path.lineWidth = 1;
  [path stroke];
}
@end

@interface BaoPermissions : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(strong) NSWindow *window;
@property(strong) NSPanel *guide;
@property(strong) BaoCard *accessibilityCard;
@property(strong) BaoCard *filesCard;
@property(strong) NSTimer *timer;
@property int seam;
@property int dock;
@property BOOL prompted;
@property BOOL filesTouched;
@property BOOL primed;
@property BOOL accessWasOn;
@property BOOL filesWasOn;
@property(copy) NSString *appPath;
@property(copy) NSString *shotPath;
@end

@implementation BaoPermissions
- (BOOL)accessibilityOn {
  if (self.seam == 1) return NO;
  if (self.seam == 2) return YES;
  return AXIsProcessTrusted();
}
- (BOOL)filesOn {
  if (self.seam == 1) return NO;
  if (self.seam == 2) return YES;
  return [folderState() isEqualToString:@"allowed"];
}
- (void)refresh {
  BOOL access = [self accessibilityOn];
  BOOL files = [self filesOn];
  [self.accessibilityCard showAllowed:access button:self.prompted ? @"Open" : @"Allow"];
  [self.filesCard showAllowed:files button:self.filesTouched ? @"Open" : @"Allow"];
  if (self.primed && self.seam == 0 && ((access && !self.accessWasOn) || (files && !self.filesWasOn))) {
    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
    [self.guide close];
    self.dock = 0;
  }
  self.accessWasOn = access;
  self.filesWasOn = files;
  self.primed = YES;
  [self placeGuide];
}
- (void)allowAccessibility:(id)sender {
  if (!self.prompted && self.seam == 0) {
    self.prompted = YES;
    NSDictionary *opts = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
  }
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:kAccessibilityURL]];
  self.dock = 1;
  [self showGuide];
  [self refresh];
}
- (void)allowFiles:(id)sender {
  if (!self.filesTouched && self.seam == 0) {
    self.filesTouched = YES;
    DIR *dir = opendir(chromeFolder().fileSystemRepresentation);
    if (dir) closedir(dir);
  }
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:kFilesURL]];
  self.dock = 2;
  [self showGuide];
  [self refresh];
}
- (void)showGuide {
  if (!self.guide) {
    self.guide = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 520, 76) styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
    self.guide.level = NSFloatingWindowLevel;
    self.guide.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorTransient;
    self.guide.hidesOnDeactivate = NO;
    self.guide.floatingPanel = YES;
    self.guide.opaque = YES;
    self.guide.hasShadow = YES;
    self.guide.movable = NO;
    BaoGuideView *view = [[BaoGuideView alloc] initWithFrame:NSMakeRect(0, 0, 520, 76)];
    self.guide.contentView = view;
  }
  BaoGuideView *view = (BaoGuideView *)self.guide.contentView;
  view.line = self.dock == 2 ? kFilesLine : kDragLine;
  view.showTile = self.dock == 1;
  for (NSView *child in view.subviews.copy) [child removeFromSuperview];
  if (view.showTile) {
    BaoDragTile *tile = [[BaoDragTile alloc] initWithFrame:NSMakeRect(16, 14, 48, 48)];
    tile.appPath = self.appPath;
    tile.toolTip = @"Drag Bao into the list";
    [view addSubview:tile];
  }
  [view setNeedsDisplay:YES];
  [self placeGuide];
  [self.guide orderFront:nil];
}
- (void)placeGuide {
  if (!self.guide || self.dock == 0) return;
  NSRect settings = settingsFrame();
  if (NSIsEmptyRect(settings)) return;
  CGFloat width = MIN(MAX(NSWidth(settings) - 24, 360), NSWidth(settings) - 16);
  NSRect frame = NSMakeRect(NSMinX(settings) + 12, NSMinY(settings) + 8, width, 76);
  [self.guide setFrame:frame display:YES];
  [self.guide orderFront:nil];
}
- (void)windowWillClose:(NSNotification *)note {
  [self.timer invalidate];
  [self.guide close];
  [NSApp terminate:nil];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
- (void)writeShot:(NSString *)path view:(NSView *)view {
  if (!view || path.length == 0) return;
  NSRect bounds = view.bounds;
  if (NSIsEmptyRect(bounds)) return;
  [view display];
  NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:bounds];
  if (!rep) return;
  [view cacheDisplayInRect:bounds toBitmapImageRep:rep];
  NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  [png writeToFile:path atomically:YES];
}
- (void)captureShot:(NSTimer *)timer {
  NSString *base = self.shotPath;
  NSView *frame = self.window.contentView.superview ?: self.window.contentView;
  [self writeShot:base view:frame];
  if (self.guide) [self writeShot:[[base stringByDeletingPathExtension] stringByAppendingString:@"-guide.png"] view:self.guide.contentView];
  NSRect settings = settingsFrame();
  NSString *note = [NSString stringWithFormat:@"guide %@\nsettings %@\n", NSStringFromRect(self.guide.frame), NSStringFromRect(settings)];
  [note writeToFile:[[base stringByDeletingPathExtension] stringByAppendingString:@".txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  [NSApp terminate:nil];
}
@end

int bao_permissions_show(const BaoPermissionsOpts *opts) {
  if (opts->check) return printCheck();
  if (!windowServer()) {
    printf("%s\n", kHeadless.UTF8String);
    fflush(stdout);
    return 0;
  }
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    if (opts->appearance == 1) app.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    if (opts->appearance == 2) app.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    BaoPermissions *controller = [BaoPermissions new];
    controller.seam = opts->seam;
    controller.dock = opts->dock;
    controller.appPath = bundlePath();
    app.delegate = controller;
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 560, 280) styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Bao";
    window.delegate = controller;
    window.restorable = NO;
    window.backgroundColor = NSColor.windowBackgroundColor;
    controller.window = window;
    BaoCard *access = [[BaoCard alloc] initWithTitle:kAccessibilityTitle purpose:kAccessibilityPurpose];
    BaoCard *files = [[BaoCard alloc] initWithTitle:kFilesTitle purpose:kFilesPurpose];
    CGFloat cardWidth = 520;
    CGFloat accessHeight = [access fittedHeightForWidth:cardWidth];
    CGFloat filesHeight = [files fittedHeightForWidth:cardWidth];
    CGFloat gap = 12;
    CGFloat margin = 20;
    files.frame = NSMakeRect(margin, margin, cardWidth, filesHeight);
    access.frame = NSMakeRect(margin, margin + filesHeight + gap, cardWidth, accessHeight);
    [window setContentSize:NSMakeSize(cardWidth + margin * 2, margin + filesHeight + gap + accessHeight + margin)];
    access.action.target = controller;
    access.action.action = @selector(allowAccessibility:);
    files.action.target = controller;
    files.action.action = @selector(allowFiles:);
    access.action.keyEquivalent = @"\r";
    controller.accessibilityCard = access;
    controller.filesCard = files;
    [window.contentView addSubview:access];
    [window.contentView addSubview:files];
    [controller refresh];
    [window center];
    [app activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
    if (opts->dock) {
      NSString *url = opts->dock == 2 ? kFilesURL : kAccessibilityURL;
      [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:url]];
      [controller showGuide];
    }
    controller.timer = [NSTimer scheduledTimerWithTimeInterval:0.5 target:controller selector:@selector(refresh) userInfo:nil repeats:YES];
    if (opts->shot) {
      controller.shotPath = [NSString stringWithUTF8String:opts->shot];
      [NSTimer scheduledTimerWithTimeInterval:2.0 target:controller selector:@selector(captureShot:) userInfo:nil repeats:NO];
    }
    [app run];
  }
  return 0;
}
