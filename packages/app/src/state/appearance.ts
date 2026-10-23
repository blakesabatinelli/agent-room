import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { APPEARANCE_MODES, type AppearanceMode } from "../palette";
import { shell } from "../native/shell";

const KEY = "agent-room.appearance";

interface State {
  /** "system" follows the Mac or phone; "light" and "dark" override it. */
  mode: AppearanceMode;
  set(mode: AppearanceMode): void;
}

export const useAppearance = create<State>((set) => ({
  mode: "system",
  set(mode) {
    set({ mode });
    try { shell?.setAppearance?.(mode); } catch { /* the window keeps following the system */ }
    void AsyncStorage.setItem(KEY, mode).catch(() => {});
  },
}));

/** Read the saved choice once at start. A missing or odd value means "system". */
export async function loadAppearance(): Promise<void> {
  try {
    const v = (await AsyncStorage.getItem(KEY)) as AppearanceMode | null;
    if (v && APPEARANCE_MODES.includes(v)) { useAppearance.setState({ mode: v }); shell?.setAppearance?.(v); }
  } catch { /* system */ }
}
