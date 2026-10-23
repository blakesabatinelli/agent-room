// Starts the Agent Room hub when the Mac app opens, and manages start-at-login.
// Installed app (1.7): runs the bundled Node on the bundled hub, Contents/Resources/node + Resources/Hub/hub.mjs, directly,
// with no shell. Xcode dev runs have no bundle, so they fall back to ./run.sh in the repo's hub folder (Info.plist AgentRoomHubDir).
// Copied into the macOS Xcode target by Setup.command.
#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h> // 4.7: NSApp, for the update check
#import <unistd.h>
#import <React/RCTBridgeModule.h>

@interface HubLauncher : NSObject <RCTBridgeModule>
@end

static NSTask *hubTask;
static NSString *const kHealthURL = @"http://127.0.0.1:4747/health";
static NSString *const kAgentLabel = @"com.agentroom.hub";

static NSString *ARHubDir(void) {
  return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"AgentRoomHubDir"];
}
static NSString *ARDataDir(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".agent-room"];
}
static NSString *ARLogPath(void) {
  return [ARDataDir() stringByAppendingPathComponent:@"hub.log"];
}
// 1.2: the secret the hub writes at every start. POST /pair/local needs it, so a remote caller that only reaches the hub through a local
// TCP forwarder can't pair. Returns nil unless the file is a plain file (not a link) owned by this user and closed to group and others.
static NSString *ARLocalPairSecret(void) {
  NSString *path = [ARDataDir() stringByAppendingPathComponent:@"local-pair.secret"];
  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil]; // describes a symlink itself, never follows it
  if (!attrs || ![attrs[NSFileType] isEqualToString:NSFileTypeRegular]) return nil;
  if ([attrs[NSFileOwnerAccountID] unsignedIntValue] != (unsigned int)getuid()) return nil;
  if (([attrs[NSFilePosixPermissions] unsignedShortValue] & 0077) != 0) return nil;
  NSData *data = [NSData dataWithContentsOfFile:path];
  NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
  text = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  // The hub writes 32 random bytes as 64 lowercase hex characters. Anything else is not ours.
  if (text.length != 64) return nil;
  NSCharacterSet *notHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  if ([text rangeOfCharacterFromSet:notHex].location != NSNotFound) return nil;
  return text;
}
static NSString *ARAgentPlist(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/LaunchAgents/com.agentroom.hub.plist"];
}

// ---- what to launch: the bundled runtime when it's there, the repo's run.sh otherwise
static NSString *ARBundledNode(void) {
  NSString *p = [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"node"];
  return [[NSFileManager defaultManager] isExecutableFileAtPath:p] ? p : nil;
}
static NSString *ARBundledHubDir(void) {
  NSString *d = [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"Hub"];
  return [[NSFileManager defaultManager] fileExistsAtPath:[d stringByAppendingPathComponent:@"hub.mjs"]] ? d : nil;
}
// @{ @"program": @[ executable, args... ], @"cwd": folder }, or nil when there is no hub to run.
static NSDictionary *ARLaunchSpec(void) {
  NSString *node = ARBundledNode(), *hubDir = ARBundledHubDir();
  if (node && hubDir) {
    return @{ @"program": @[ node, @"--enable-source-maps", [hubDir stringByAppendingPathComponent:@"hub.mjs"] ], @"cwd": hubDir };
  }
  NSString *dev = ARHubDir();
  if (dev.length > 0 && [[NSFileManager defaultManager] fileExistsAtPath:dev]) {
    // Login shell so the hub sees the same PATH as Terminal (node, claude, codex, tailscale).
    return @{ @"program": @[ @"/bin/zsh", @"-lc", @"exec /bin/sh ./run.sh" ], @"cwd": dev };
  }
  return nil;
}
// The usual places the agent CLIs live (the hub's main.ts adds the same ones), then the given PATH.
static NSDictionary *AREnvironment(NSString *basePath) {
  NSString *home = NSHomeDirectory();
  NSArray *extra = @[ [home stringByAppendingPathComponent:@".local/bin"], [home stringByAppendingPathComponent:@".npm-global/bin"],
                      [home stringByAppendingPathComponent:@".bun/bin"], @"/opt/homebrew/bin", @"/usr/local/bin" ];
  return @{ @"PATH": [[extra arrayByAddingObject:basePath] componentsJoinedByString:@":"], @"AGENT_ROOM_DATA": ARDataDir() };
}

static BOOL ARHealthy(void) {
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:kHealthURL]
                                                     cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                 timeoutInterval:1.5];
  __block BOOL ok = NO;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *d, NSURLResponse *resp, NSError *err) {
    ok = (err == nil && [(NSHTTPURLResponse *)resp statusCode] == 200);
    dispatch_semaphore_signal(done);
  }] resume];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)));
  return ok;
}

static BOOL ARWaitHealthy(int seconds) {
  for (int i = 0; i < seconds * 2; i++) {
    if (ARHealthy()) return YES;
    [NSThread sleepForTimeInterval:0.5];
  }
  return NO;
}

static int ARRun(NSString *shellCommand) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/bin/zsh"];
  t.arguments = @[ @"-lc", shellCommand ];
  NSError *err = nil;
  if (![t launchAndReturnError:&err]) return -1;
  [t waitUntilExit];
  return t.terminationStatus;
}

@implementation HubLauncher

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_EXPORT_METHOD(ensureRunning:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (ARHealthy()) { resolve(@{ @"started": @NO, @"log": ARLogPath() }); return; }

    NSDictionary *spec = ARLaunchSpec();
    if (!spec) {
      reject(@"no_hub", @"Can't find the hub. Reinstall Agent Room from the DMG. If you're developing, double-click Setup.command again.", nil);
      return;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    [fm createDirectoryAtPath:ARDataDir() withIntermediateDirectories:YES attributes:nil error:nil];
    if (![fm fileExistsAtPath:ARLogPath()]) [fm createFileAtPath:ARLogPath() contents:nil attributes:nil];
    NSFileHandle *log = [NSFileHandle fileHandleForWritingAtPath:ARLogPath()];
    [log seekToEndOfFile];

    NSArray *program = spec[@"program"];
    NSTask *t = [NSTask new];
    t.executableURL = [NSURL fileURLWithPath:program[0]];
    t.arguments = [program subarrayWithRange:NSMakeRange(1, program.count - 1)];
    t.currentDirectoryURL = [NSURL fileURLWithPath:spec[@"cwd"]];
    NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
    [env addEntriesFromDictionary:AREnvironment(env[@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin")];
    t.environment = env;
    t.standardOutput = log;
    t.standardError = log;
    NSError *err = nil;
    if (![t launchAndReturnError:&err]) {
      reject(@"launch_failed", [NSString stringWithFormat:@"Couldn't start the hub: %@", err.localizedDescription], err);
      return;
    }
    hubTask = t;
    if (ARWaitHealthy(30)) resolve(@{ @"started": @YES, @"log": ARLogPath() });
    else reject(@"timeout", [NSString stringWithFormat:@"The hub didn't start. Details are in %@", ARLogPath()], nil);
  });
}

// Resolves to the hub's local pairing secret, or null when the file is missing or isn't private to this user.
RCT_EXPORT_METHOD(localPairSecret:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *secret = ARLocalPairSecret();
  resolve(secret ?: [NSNull null]);
}

// 4.7: Sparkle. True only in a build that links it (the release build); the app shows "Check for updates" only then.
RCT_EXPORT_METHOD(updaterAvailable:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(NSClassFromString(@"SPUStandardUpdaterController") != nil && [NSApp.delegate respondsToSelector:NSSelectorFromString(@"checkForUpdates:")]));
}

// 4.7: opens Sparkle's own update window (the same as the "Check for Updates…" menu item). Does nothing without Sparkle.
RCT_EXPORT_METHOD(checkForUpdates) {
  dispatch_async(dispatch_get_main_queue(), ^{
    id delegate = NSApp.delegate;
    SEL check = NSSelectorFromString(@"checkForUpdates:");
    if (NSClassFromString(@"SPUStandardUpdaterController") != nil && [delegate respondsToSelector:check]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
      [delegate performSelector:check withObject:nil];
#pragma clang diagnostic pop
    }
  });
}

RCT_EXPORT_METHOD(startAtLoginEnabled:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@([[NSFileManager defaultManager] fileExistsAtPath:ARAgentPlist()]));
}

RCT_EXPORT_METHOD(setStartAtLogin:(BOOL)enabled resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *plistPath = ARAgentPlist();
    ARRun([NSString stringWithFormat:@"launchctl unload '%@' 2>/dev/null; true", plistPath]);
    if (!enabled) {
      [[NSFileManager defaultManager] removeItemAtPath:plistPath error:nil];
      resolve(@NO);
      return;
    }
    NSDictionary *spec = ARLaunchSpec();
    if (!spec) { reject(@"no_hub", @"Can't find the hub to start at login.", nil); return; }
    [[NSFileManager defaultManager] createDirectoryAtPath:[plistPath stringByDeletingLastPathComponent]
                              withIntermediateDirectories:YES attributes:nil error:nil];
    // From the DMG this points at the bundled node and hub.mjs; in a dev run it keeps using run.sh.
    NSDictionary *plist = @{
      @"Label": kAgentLabel,
      @"ProgramArguments": spec[@"program"],
      @"WorkingDirectory": spec[@"cwd"],
      @"EnvironmentVariables": AREnvironment(@"/usr/bin:/bin:/usr/sbin:/sbin"),
      @"RunAtLoad": @YES,
      @"KeepAlive": @YES,
      @"ThrottleInterval": @10,
      @"StandardOutPath": ARLogPath(),
      @"StandardErrorPath": ARLogPath(),
    };
    NSError *err = nil;
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:plist format:NSPropertyListXMLFormat_v1_0 options:0 error:&err];
    if (!data || ![data writeToFile:plistPath atomically:YES]) {
      reject(@"write_failed", @"Couldn't save the login item.", err);
      return;
    }
    // Hand the hub over to launchd: stop the copy this app started, then load the agent.
    if (hubTask.running) { [hubTask terminate]; [hubTask waitUntilExit]; }
    ARRun(@"lsof -ti tcp:4747 | xargs kill 2>/dev/null; true");
    ARRun([NSString stringWithFormat:@"launchctl load '%@'", plistPath]);
    if (ARWaitHealthy(30)) resolve(@YES);
    else reject(@"timeout", [NSString stringWithFormat:@"The hub didn't restart. Details are in %@", ARLogPath()], nil);
  });
}

@end
