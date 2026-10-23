import { NativeEventEmitter, NativeModules, Platform, requireNativeComponent, type ViewProps } from "react-native";
import type { ComponentType } from "react";

/**
 * 3.1: the small piece of the Mac that React Native macOS does not give us, written in macos/AgentRoom-macOS/ARShell.m.
 * Every part is optional: when the native module isn't in the build (an older build, iOS), the app keeps working
 * with the pale opaque sidebar, the colour scheme from React Native, and the in-window shortcut.
 */
type Shell = {
  /** True when the build has the visual effect view (the translucent sidebar). */
  hasVisualEffect?: boolean;
  /** "system", "light" or "dark": the window's own controls (fields, scroll bars, switches) follow the choice. */
  setAppearance?(mode: string): void;
  addListener?(name: string): void;
  removeListeners?(n: number): void;
};

const isMac = Platform.OS === ("macos" as string);
export const shell: Shell | undefined = isMac ? (NativeModules.ARShell as Shell | undefined) : undefined;

/** The ⌘K menu item (Go to...) in the native menu bar. Fires "ARGoTo" wherever the focus is. */
export function onGoTo(fn: () => void): () => void {
  if (!shell?.addListener) return () => {};
  const em = new NativeEventEmitter(shell as never);
  const sub = em.addListener("ARGoTo", fn);
  return () => sub.remove();
}

export type VisualEffectProps = ViewProps & { material?: "sidebar" | "headerView" | "underWindowBackground"; blending?: "behindWindow" | "withinWindow" };
/** A view backed by NSVisualEffectView, or undefined when the build doesn't have it. */
export const VisualEffectView: ComponentType<VisualEffectProps> | undefined =
  shell?.hasVisualEffect ? requireNativeComponent<VisualEffectProps>("ARVisualEffectView") : undefined;
