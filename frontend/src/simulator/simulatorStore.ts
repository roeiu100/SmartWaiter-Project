import { create } from "zustand";
import type { UUID } from "../types/database";

/**
 * Guest-side cart + table-id holder.
 *
 * Orders used to live here as an in-memory Zustand "fake backend"; they are
 * now persisted to Supabase through the real API (see
 * [services/orderApi.ts](../services/orderApi.ts) and the Kitchen / Runner
 * screens). This store keeps only the pieces that are *client-local* by
 * nature: the guest's draft cart and the table id they're sitting at.
 */

export interface CartLine {
  menuItemId: UUID;
  quantity: number;
}

interface SimulatorState {
  /** Shared guest cart (menu screen + AI chat) — quantities by menu_item id. */
  guestCartQuantities: Record<string, number>;
  guestTableId: string;
  setGuestCartLine: (menuItemId: UUID, quantity: number) => void;
  setGuestTableId: (tableId: string) => void;
  clearGuestCart: () => void;
  /** Utility for tests / demo: resets cart + table to defaults. */
  resetSimulator: () => void;
}

export const useSimulatorStore = create<SimulatorState>((set) => ({
  guestCartQuantities: {},
  guestTableId: "T12",

  setGuestCartLine: (menuItemId, quantity) => {
    set((s) => {
      const next = { ...s.guestCartQuantities };
      if (quantity <= 0) delete next[menuItemId];
      else next[menuItemId] = quantity;
      return { guestCartQuantities: next };
    });
  },

  setGuestTableId: (tableId) => set({ guestTableId: tableId }),

  clearGuestCart: () => set({ guestCartQuantities: {} }),

  resetSimulator: () => set({ guestCartQuantities: {}, guestTableId: "T12" }),
}));
