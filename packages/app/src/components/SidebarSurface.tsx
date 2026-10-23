import React from "react";
import { View } from "react-native";
import { VisualEffectView } from "../native/shell";
import { usePalette } from "../theme";

/**
 * 3.1: the sidebar's background. On a Mac build that has the native visual effect view (ARShell.m) it is the translucent "sidebar"
 * material, with a light veil of the sidebar colour over it so it still reads as the pale sidebar. Anywhere else, and on a build
 * without ARShell.m, it is the plain pale sidebar colour. Text sits on the same colours in both cases.
 */
export function SidebarSurface({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  if (!VisualEffectView) return <View style={{ flex: 1, backgroundColor: p.sidebar }}>{children}</View>;
  return (
    <VisualEffectView material="sidebar" blending="behindWindow" style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: p.sidebarVeil }}>{children}</View>
    </VisualEffectView>
  );
}
