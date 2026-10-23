import { NativeModules, Platform } from "react-native";

type Launcher = {
  ensureRunning(): Promise<{ started: boolean; log: string }>;
  startAtLoginEnabled(): Promise<boolean>;
  setStartAtLogin(enabled: boolean): Promise<boolean>;
};

const native = NativeModules.HubLauncher as Launcher | undefined;

/** The Mac app runs and pairs with its own hub; the phone app pairs over Tailscale. */
export const launcher: Launcher | undefined = Platform.OS === ("macos" as string) ? native : undefined;
export const LOCAL_HUB = "http://127.0.0.1:4747";
