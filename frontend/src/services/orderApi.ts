import { MENU_API_BASE } from "./menuApi";

export type ActiveOrderItemStatus = "pending" | "ready" | "served";

/** An order_item row returned by the server, with the joined menu name. */
export interface ActiveOrderItem {
  id: string;
  order_id: string;
  menu_item_id: string;
  quantity: number;
  unit_price: number;
  status: ActiveOrderItemStatus;
  ready_at?: string | null;
  served_at?: string | null;
  notes?: string | null;
  menu_item_name: string;
}

/** Full active order as returned by GET /api/orders/active. */
export interface ActiveOrder {
  id: string;
  table_id: string;
  status: "submitted" | "preparing" | "ready" | "delivered" | "cancelled";
  total_price: number;
  created_at: string;
  submitted_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  guest_note: string | null;
  items: ActiveOrderItem[];
}

export interface SubmitOrderLine {
  menu_item_id: string;
  quantity: number;
  notes?: string;
}

/**
 * Supabase's PostgREST sometimes returns `timestamp` (no-timezone) columns
 * as e.g. `"2026-05-02T15:45:00"` — no trailing `Z` or offset. JavaScript
 * then parses that as local time, which on an east-of-UTC device makes
 * "now"-ish orders look hours old. The backend only ever writes UTC, so
 * we tag any timezone-less string as UTC defensively.
 */
function toUtcIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  // Already has a `Z` or an explicit +hh:mm / -hh:mm offset → leave alone.
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s;
  return `${s}Z`;
}

function normalizeItem(raw: unknown): ActiveOrderItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  const order_id = String(r.order_id ?? "");
  const menu_item_id = String(r.menu_item_id ?? "");
  if (!id || !order_id || !menu_item_id) return null;
  const qty = Number(r.quantity ?? 1);
  const unit_price = Number(r.unit_price ?? 0);
  const status =
    r.status === "ready" || r.status === "served" || r.status === "pending"
      ? (r.status as ActiveOrderItemStatus)
      : "pending";
  const name = r.menu_item_name;
  return {
    id,
    order_id,
    menu_item_id,
    quantity: Number.isFinite(qty) ? qty : 1,
    unit_price: Number.isFinite(unit_price) ? unit_price : 0,
    status,
    ready_at: toUtcIso(r.ready_at),
    served_at: toUtcIso(r.served_at),
    notes: typeof r.notes === "string" ? r.notes : null,
    menu_item_name: typeof name === "string" ? name : "",
  };
}

export function normalizeActiveOrder(raw: unknown): ActiveOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  const table_id = String(r.table_id ?? "");
  if (!id || !table_id) return null;
  const statusRaw = typeof r.status === "string" ? r.status : "submitted";
  const status: ActiveOrder["status"] =
    statusRaw === "preparing" ||
    statusRaw === "ready" ||
    statusRaw === "delivered" ||
    statusRaw === "cancelled"
      ? statusRaw
      : "submitted";
  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items = rawItems
    .map(normalizeItem)
    .filter((it): it is ActiveOrderItem => it !== null);
  const createdAt = toUtcIso(r.created_at) ?? new Date().toISOString();
  return {
    id,
    table_id,
    status,
    total_price: Number(r.total_price ?? 0),
    created_at: createdAt,
    submitted_at: toUtcIso(r.submitted_at),
    ready_at: toUtcIso(r.ready_at),
    served_at: toUtcIso(r.served_at),
    guest_note: typeof r.guest_note === "string" ? r.guest_note : null,
    items,
  };
}

export async function fetchActiveOrders(): Promise<ActiveOrder[]> {
  const res = await fetch(`${MENU_API_BASE}/api/orders/active`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Fetch active orders failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeActiveOrder)
    .filter((o): o is ActiveOrder => o !== null);
}

export async function submitOrder(
  tableId: string,
  lines: SubmitOrderLine[]
): Promise<ActiveOrder> {
  const res = await fetch(`${MENU_API_BASE}/api/orders`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ table_id: tableId, items: lines }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Submit order failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const order = normalizeActiveOrder(await res.json());
  if (!order) throw new Error("Server returned an invalid order");
  return order;
}

export async function patchItemStatus(
  orderId: string,
  itemId: string,
  status: ActiveOrderItemStatus
): Promise<void> {
  const url = `${MENU_API_BASE}/api/orders/${encodeURIComponent(
    orderId
  )}/items/${encodeURIComponent(itemId)}/status`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Update item status failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
}
