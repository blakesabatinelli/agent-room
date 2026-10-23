import { NativeModules, Platform } from "react-native";

type Launcher = {
  ensureRunning(): Promise<{ started: boolean; log: string }>;
  startAtLoginEnabled(): Promise<boolean>;
  setStartAtLogin(enabled: boolean): Promise<boolean>;
  /** 1.1: the Mac's folder chooser. Resolves to the chosen path, or null if cancelled. Not built into the native module yet, so the app checks for it. */
  chooseFolder?(): Promise<string | null>;
};

const native = NativeModules.HubLauncher as Launcher | undefined;

/** The Mac app runs and pairs with its own hub; the phone app pairs over Tailscale. */
export const launcher: Launcher | undefined = Platform.OS === ("macos" as string) ? native : undefined;
export const LOCAL_HUB = "http://127.0.0.1:4747";
