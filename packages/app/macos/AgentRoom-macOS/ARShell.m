// 3.1: the pieces of the Mac that React Native macOS 0.79 doesn't have, used by packages/app/src/native/shell.ts.
//   1. ARVisualEffectView: a view backed by NSVisualEffectView. The sidebar uses it for the translucent "sidebar" material.
//      React Native macOS has no component for this (it only has `allowsVibrancy`, which says whether a view is vibrant on top of one).
//   2. ARShell (native module):
//        setAppearance("system" | "light" | "dark")  makes the window's own controls (fields, scroll bars, switches) follow the choice
//        constants.hasVisualEffect                    lets JS know this build has the view above
//        event "ARGoTo"                               the "Go > Go to..." menu item, ⌘K, so the shortcut works wherever the focus is
// Written without a Mac to build it on: if anything here fails to compile, delete this file from the Xcode target. The app then falls
// back to the pale opaque sidebar and the in-window ⌘K, and nothing else changes. Copied into the Xcode target like HubLauncher.m.
#import <Cocoa/Cocoa.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTConvert.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTView.h>
#import <React/RCTViewManager.h>

// ---------- 1. the view

@interface ARVisualEffectContainer : RCTView
@property (nonatomic, strong) NSVisualEffectView *effect;
- (void)setMaterialName:(NSString *)name;
- (void)setBlendingName:(NSString *)name;
@end

@implementation ARVisualEffectContainer

- (instancetype)initWithFrame:(NSRect)frame
{
  if ((self = [super initWithFrame:frame])) {
    _effect = [[NSVisualEffectView alloc] initWithFrame:self.bounds];
    _effect.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    _effect.state = NSVisualEffectStateFollowsWindowActiveState;
    _effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    _effect.material = NSVisualEffectMaterialSidebar;
    // Under everything React puts in this view.
    [self addSubview:_effect positioned:NSWindowBelow relativeTo:nil];
  }
  return self;
}

- (void)setMaterialName:(NSString *)name
{
  if ([name isEqualToString:@"headerView"]) _effect.material = NSVisualEffectMaterialHeaderView;
  else if ([name isEqualToString:@"underWindowBackground"]) _effect.material = NSVisualEffectMaterialUnderWindowBackground;
  else _effect.material = NSVisualEffectMaterialSidebar;
}

- (void)setBlendingName:(NSString *)name
{
  _effect.blendingMode = [name isEqualToString:@"withinWindow"] ? NSVisualEffectBlendingModeWithinWindow : NSVisualEffectBlendingModeBehindWindow;
}

@end

@interface ARVisualEffectViewManager : RCTViewManager
@end

@implementation ARVisualEffectViewManager

RCT_EXPORT_MODULE(ARVisualEffectView)

- (NSView *)view
{
  return [ARVisualEffectContainer new];
}

RCT_CUSTOM_VIEW_PROPERTY(material, NSString, ARVisualEffectContainer)
{
  [view setMaterialName:json ? [RCTConvert NSString:json] : @"sidebar"];
}

RCT_CUSTOM_VIEW_PROPERTY(blending, NSString, ARVisualEffectContainer)
{
  [view setBlendingName:json ? [RCTConvert NSString:json] : @"behindWindow"];
}

@end

// ---------- 2. the module

static const NSInteger kARGoToTag = 3100;

@interface ARShell : RCTEventEmitter <RCTBridgeModule>
@end

@implementation ARShell {
  BOOL _observing;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"ARGoTo" ];
}

- (NSDictionary *)constantsToExport
{
  return @{ @"hasVisualEffect" : @YES };
}

- (void)startObserving
{
  _observing = YES;
}

- (void)stopObserving
{
  _observing = NO;
}

- (instancetype)init
{
  if ((self = [super init])) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self installGoToMenu]; });
  }
  return self;
}

// "Go > Go to..." with ⌘K, placed before the Window menu. After a JS reload the item is kept and pointed at the new module.
- (void)installGoToMenu
{
  NSMenu *main = NSApp.mainMenu;
  if (!main) return;
  NSMenuItem *top = [main itemWithTitle:@"Go"];
  if (!top) {
    top = [[NSMenuItem alloc] initWithTitle:@"Go" action:nil keyEquivalent:@""];
    top.submenu = [[NSMenu alloc] initWithTitle:@"Go"];
    NSInteger at = [main indexOfItemWithTitle:@"Window"];
    [main insertItem:top atIndex:at >= 0 ? at : main.numberOfItems];
  }
  NSMenuItem *item = [top.submenu itemWithTag:kARGoToTag];
  if (!item) {
    item = [[NSMenuItem alloc] initWithTitle:@"Go to…" action:@selector(goTo:) keyEquivalent:@"k"];
    item.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    item.tag = kARGoToTag;
    [top.submenu addItem:item];
  }
  item.target = self;
  item.action = @selector(goTo:);
}

- (void)goTo:(id)sender
{
  if (_observing) [self sendEventWithName:@"ARGoTo" body:@{}];
}

RCT_EXPORT_METHOD(setAppearance : (NSString *)mode)
{
  if ([mode isEqualToString:@"dark"]) NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
  else if ([mode isEqualToString:@"light"]) NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  else NSApp.appearance = nil; // follow the system
}

@end
