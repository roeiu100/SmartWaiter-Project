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

export interface GuestCartLineState {
  quantity: number;
  notes?: string;
}

export interface CartLine {
  menuItemId: UUID;
  quantity: number;
  notes?: string;
}

interface SimulatorState {
  /** Shared guest cart (menu screen + AI chat) — lines by menu_item id. */
  guestCart: Record<string, GuestCartLineState>;
  guestTableId: string;
  /** True once a QR/deep-link has pinned the table id; guest can no longer edit it. */
  isGuestTableLocked: boolean;
  setGuestCartLine: (
    menuItemId: UUID,
    quantity: number,
    notes?: string
  ) => void;
  setGuestTableId: (tableId: string) => void;
  /** Called from the `table/:tableId` deep link — pins the table id for the session. */
  lockGuestTable: (tableId: string) => void;
  clearGuestCart: () => void;
  /** Utility for tests / demo: resets cart + table to defaults. */
  resetSimulator: () => void;
}

export const useSimulatorStore = create<SimulatorState>((set) => ({
  guestCart: {},
  guestTableId: "T12",
  isGuestTableLocked: false,

  setGuestCartLine: (menuItemId, quantity, notes) => {
    set((s) => {
      const next = { ...s.guestCart };
      if (quantity <= 0) {
        delete next[menuItemId];
        return { guestCart: next };
      }
      const prev = next[menuItemId];
      let nextNotes: string | undefined;
      if (notes !== undefined) {
        const trimmed = notes.trim();
        nextNotes = trimmed.length > 0 ? trimmed : undefined;
      } else {
        nextNotes = prev?.notes;
      }
      next[menuItemId] = {
        quantity,
        ...(nextNotes ? { notes: nextNotes } : {}),
      };
      return { guestCart: next };
    });
  },

  setGuestTableId: (tableId) => set({ guestTableId: tableId }),

  lockGuestTable: (tableId) =>
    set({ guestTableId: tableId, isGuestTableLocked: true }),

  clearGuestCart: () => set({ guestCart: {} }),

  resetSimulator: () =>
    set({ guestCart: {}, guestTableId: "T12", isGuestTableLocked: false }),
}));
