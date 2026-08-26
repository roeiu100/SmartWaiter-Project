import { create } from "zustand";

/**
 * One AI-waiter cancellation request awaiting a manager's approve/reject.
 * Populated by ManagerTabNavigator (fetch on mount + live socket updates) so
 * it stays correct regardless of which Manager tab is currently focused —
 * see ManagerScreen (banner) and TableMapScreen (full list + actions).
 */
export interface PendingCancellationItem {
  order_id: string;
  item_id: string;
  table_id: string;
  menu_item_name: string;
  quantity: number;
  reason: string;
  requested_at: string;
}

interface PendingCancellationsState {
  items: PendingCancellationItem[];
  setItems: (items: PendingCancellationItem[]) => void;
  upsertItem: (item: PendingCancellationItem) => void;
  removeItem: (itemId: string) => void;
}

export const usePendingCancellationsStore = create<PendingCancellationsState>(
  (set) => ({
    items: [],

    setItems: (items) => set({ items }),

    upsertItem: (item) =>
      set((s) => ({
        items: [...s.items.filter((i) => i.item_id !== item.item_id), item],
      })),

    removeItem: (itemId) =>
      set((s) => ({ items: s.items.filter((i) => i.item_id !== itemId) })),
  })
);
