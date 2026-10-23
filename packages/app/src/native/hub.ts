import { NativeModules, Platform } from "react-native";

type Launcher = {
  ensureRunning(): Promise<{ started: boolean; log: string }>;
  startAtLoginEnabled(): Promise<boolean>;
  setStartAtLogin(enabled: boolean): Promise<boolean>;
  /** 1.1: the Mac's folder chooser. Resolves to the chosen path, or null if cancelled. Not built into the native module yet, so the app checks for it. */
  chooseFolder?(): Promise<string | null>;
  /** 1.2: the hub's local pairing secret, read from ~/.agent-room/local-pair.secret. Resolves to null when the file is missing, unreadable or not private to this user. */
  localPairSecret?(): Promise<string | null>;
  /** 4.7: true in a build that carries Sparkle (the release build). Older builds don't have the method. */
  updaterAvailable?(): Promise<boolean>;
  /** 4.7: opens Sparkle's update window, the same as "Check for Updates…" in the app menu. */
  checkForUpdates?(): void;
};

const native = NativeModules.HubLauncher as Launcher | undefined;

/** The Mac app runs and pairs with its own hub; the phone app pairs over Tailscale. */
export const launcher: Launcher | undefined = Platform.OS === ("macos" as string) ? native : undefined;
export const LOCAL_HUB = "http://127.0.0.1:4747";

/**
 * 1.2: what the hub wants before it hands this Mac a device token (sent as x-agent-room-local-secret). The hub makes a new one each time it
 * starts, so read it after ensureRunning(), every time. Throws a plain message when it can't be read.
 */
export async function readLocalPairSecret(): Promise<string> {
  const secret = launcher?.localPairSecret ? await launcher.localPairSecret().catch(() => null) : null;
  if (!secret) throw new Error("Couldn't read the pairing key the hub keeps in ~/.agent-room. Quit Agent Room and open it again. If it keeps happening, update the app.");
  return secret;
}
