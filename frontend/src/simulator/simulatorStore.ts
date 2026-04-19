import { create } from "zustand";
import type {
  OrderItemRow,
  OrderRow,
  OrderStatus,
  UUID,
} from "../types/database";
import type { MenuItemRow } from "../types/database";
import { MOCK_MENU_ITEMS } from "../data/mockMenu";

/**
 * SIMULATOR — in-memory “fake backend” + pub/sub feel via Zustand.
 *
 * REPLACE WITH REAL BACKEND:
 * - Subscribe to WebSocket events (order created, order status changed) instead of reading this store.
 * - POST /orders, PATCH /orders/:id/status, GET /menu, etc. from your Node + PostgreSQL API.
 * - Keep the same OrderRow / OrderItemRow shapes where possible so UI changes stay small.
 */

export interface CartLine {
  menuItemId: UUID;
  quantity: number;
}

/** Enriched order for UI (joins menu names). */
export interface SimulatorOrder extends OrderRow {
  items: Array<
    OrderItemRow & {
      menu_name: string;
      unit_price: number;
    }
  >;
  createdAt: number;
}

interface SimulatorState {
  /** Mirrors menu_items; simulator starts from mock data until API loads. */
  menuItems: MenuItemRow[];
  orders: SimulatorOrder[];

  /** Shared guest cart (menu screen + AI chat) — quantities by menu_item id. */
  guestCartQuantities: Record<string, number>;
  guestTableId: string;
  setGuestCartLine: (menuItemId: UUID, quantity: number) => void;
  setGuestTableId: (tableId: string) => void;
  clearGuestCart: () => void;
  /**
   * Same pipeline as Guest “Place order”: uses current guestTableId + guestCartQuantities.
   * Clears cart only when an order is actually created.
   */
  submitGuestCartToKitchen: (menu: MenuItemRow[]) => "ok" | "empty";

  /** Guest: build cart locally, then submit (pass same menu as on screen). */
  submitOrder: (tableId: string, lines: CartLine[], menu: MenuItemRow[]) => void;

  /** Kitchen: advance order to ready (runner sees it). */
  markOrderReady: (orderId: UUID) => void;

  /** Runner: food delivered to table — completes the order. */
  markOrderServed: (orderId: UUID) => void;

  /** Optional: clear demo state while testing. */
  resetSimulator: () => void;
}

function newId(prefix: string): UUID {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function buildOrder(
  tableId: string,
  lines: CartLine[],
  menuSource: MenuItemRow[]
): SimulatorOrder | null {
  const orderId = newId("ord");
  const items: SimulatorOrder["items"] = [];
  let total = 0;

  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const lineId = String(line.menuItemId).trim();
    const menu = menuSource.find(
      (m) =>
        String(m.id) === lineId ||
        String(m.id).toLowerCase() === lineId.toLowerCase()
    );
    if (!menu || !menu.is_available) continue;
    const lineTotal = menu.price * line.quantity;
    total += lineTotal;
    items.push({
      id: newId("oi"),
      order_id: orderId,
      menu_item_id: menu.id,
      status: "pending",
      quantity: line.quantity,
      menu_name: menu.name,
      unit_price: menu.price,
    });
  }

  if (items.length === 0) return null;

  const orderRow: OrderRow = {
    id: orderId,
    table_id: tableId,
    status: "submitted",
    total_price: Math.round(total * 100) / 100,
  };

  return {
    ...orderRow,
    items,
    createdAt: Date.now(),
  };
}

export const useSimulatorStore = create<SimulatorState>((set, get) => ({
  menuItems: MOCK_MENU_ITEMS,
  orders: [],
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

  submitGuestCartToKitchen: (menu) => {
    const { guestTableId, guestCartQuantities } = get();
    const lines: CartLine[] = Object.entries(guestCartQuantities)
      .filter(([, q]) => q > 0)
      .map(([menuItemId, quantity]) => ({
        menuItemId,
        quantity: Number(quantity),
      }));
    if (lines.length === 0) return "empty";
    const order = buildOrder(guestTableId.trim() || "T?", lines, menu);
    if (!order) return "empty";
    get().submitOrder(guestTableId.trim() || "T?", lines, menu);
    set({ guestCartQuantities: {} });
    return "ok";
  },

  submitOrder: (tableId, lines, menu) => {
    const order = buildOrder(tableId.trim() || "T?", lines, menu);
    if (!order) return;
    set((s) => ({ orders: [order, ...s.orders] }));
    // REPLACE: emit optimistic UI + POST /orders; reconcile with server id/status.
  },

  markOrderReady: (orderId) => {
    set((s) => ({
      orders: s.orders.map((o) => {
        if (o.id !== orderId) return o;
        const nextStatus: OrderStatus = "ready";
        return {
          ...o,
          status: nextStatus,
          items: o.items.map((it) => ({ ...it, status: "ready" as const })),
        };
      }),
    }));
    // REPLACE: PATCH /orders/:id { status: 'ready' }; WebSocket broadcasts to runners.
  },

  markOrderServed: (orderId) => {
    set((s) => ({
      orders: s.orders.map((o) => {
        if (o.id !== orderId || o.status !== "ready") return o;
        const nextStatus: OrderStatus = "delivered";
        return {
          ...o,
          status: nextStatus,
          items: o.items.map((it) => ({ ...it, status: "served" as const })),
        };
      }),
    }));
    // REPLACE: PATCH /orders/:id { status: 'delivered' }; notify guest / analytics if needed.
  },

  resetSimulator: () =>
    set({ orders: [], guestCartQuantities: {}, guestTableId: "T12" }),
}));

/**
 * Pure helpers for derived lists — use with `useMemo` in components.
 * Do not pass `.filter(...)` directly into `useSimulatorStore(...)`; a new array each call
 * breaks useSyncExternalStore (“getSnapshot should be cached”).
 */
export function getKitchenQueue(orders: SimulatorOrder[]) {
  return orders.filter((o) => o.status === "submitted" || o.status === "preparing");
}

export function getRunnerQueue(orders: SimulatorOrder[]) {
  return orders.filter((o) => o.status === "ready");
}
