#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

// 4.7: Sparkle 2. Compiled in only when the build defines AR_SPARKLE=1 (and the Sparkle pod is installed: AGENT_ROOM_SPARKLE=1 pod install),
// so a plain Xcode build without it still compiles and simply has no updater. NEEDS A MAC to build and try; nothing here can run elsewhere.
#ifndef AR_SPARKLE
#define AR_SPARKLE 0
#endif
#if AR_SPARKLE
#import <Sparkle/Sparkle.h>
#endif

@implementation AppDelegate {
#if AR_SPARKLE
  SPUStandardUpdaterController *_updaterController;
#endif
}

+ (BOOL)updaterAvailable
{
  return AR_SPARKLE ? YES : NO;
}

- (void)checkForUpdates:(id)sender
{
#if AR_SPARKLE
  [_updaterController checkForUpdates:sender];
#endif
}

#if AR_SPARKLE
// "Check for Updates…" under the app's own menu, right after "About Agent Room".
- (void)installUpdateMenuItem
{
  NSMenu *appMenu = NSApp.mainMenu.itemArray.firstObject.submenu;
  if (!appMenu) return;
  NSString *title = @"Check for Updates…";
  if ([appMenu itemWithTitle:title]) return;
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(checkForUpdates:) keyEquivalent:@""];
  item.target = self;
  [appMenu insertItem:item atIndex:MIN(1, appMenu.numberOfItems)];
}
#endif

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  // 3.1: the app has a dark mode, so the window follows the system. The Appearance setting (System, Light, Dark) is applied from JS
  // through the ARShell module once the app has read it.
  self.moduleName = @"AgentRoom";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];
  
  [super applicationDidFinishLaunching:notification];
#if AR_SPARKLE
  // SUFeedURL and SUPublicEDKey come from Info.plist. The updater checks once a day (SUScheduledCheckInterval) and installs only
  // updates signed with the matching EdDSA key, from a Developer ID signed app by the same team.
  _updaterController = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES updaterDelegate:nil userDriverDelegate:nil];
  [self installUpdateMenuItem];
#endif
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
