import { create } from "zustand";

/** 3.1: whether the ⌘K command palette is open. Opened from the sidebar's search row, the Go menu or the shortcut. */
interface State { open: boolean; show(): void; hide(): void; toggle(): void }

export const useCommandPalette = create<State>((set, get) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));
