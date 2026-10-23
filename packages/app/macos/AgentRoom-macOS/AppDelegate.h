#import <RCTAppDelegate.h>
#import <Cocoa/Cocoa.h>

@interface AppDelegate : RCTAppDelegate

/// 4.7: YES when this build carries Sparkle (built with AR_SPARKLE=1, which scripts/package-mac.sh --release does).
+ (BOOL)updaterAvailable;
/// 4.7: asks Sparkle to look for an update now and show its own window. A no-op in builds without Sparkle.
- (void)checkForUpdates:(id)sender;

@end
