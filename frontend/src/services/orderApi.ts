import { MENU_API_BASE } from "./menuApi";

export type ActiveOrderItemStatus = "pending" | "ready" | "served" | "canceled";

/** Cancellation sub-state — independent of `status`. See types/database.ts. */
export type ActiveOrderItemCancellationStatus =
  | "none"
  | "requested"
  | "approved"
  | "rejected";

export type ActiveOrderItemCanceledBy = "manager" | "ai_waiter";

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
  cancellation_status: ActiveOrderItemCancellationStatus;
  cancellation_reason: string | null;
  canceled_by: ActiveOrderItemCanceledBy | null;
  canceled_at: string | null;
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
  /** Set once the guest pays via POST /api/orders/table/:tableId/pay. NULL = still open. */
  paid_at: string | null;
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
    r.status === "ready" ||
    r.status === "served" ||
    r.status === "pending" ||
    r.status === "canceled"
      ? (r.status as ActiveOrderItemStatus)
      : "pending";
  const cancellation_status =
    r.cancellation_status === "requested" ||
    r.cancellation_status === "approved" ||
    r.cancellation_status === "rejected"
      ? (r.cancellation_status as ActiveOrderItemCancellationStatus)
      : "none";
  const canceled_by =
    r.canceled_by === "manager" || r.canceled_by === "ai_waiter"
      ? (r.canceled_by as ActiveOrderItemCanceledBy)
      : null;
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
    cancellation_status,
    cancellation_reason:
      typeof r.cancellation_reason === "string" ? r.cancellation_reason : null,
    canceled_by,
    canceled_at: toUtcIso(r.canceled_at),
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
    paid_at: toUtcIso(r.paid_at),
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

/** All unpaid orders across every table (server filters `paid_at IS NULL`). */
export async function fetchUnpaidOrders(): Promise<ActiveOrder[]> {
  const res = await fetch(`${MENU_API_BASE}/api/orders/unpaid`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Fetch unpaid orders failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeActiveOrder)
    .filter((o): o is ActiveOrder => o !== null);
}

export interface PayTableResult {
  table_id: string;
  paid_at: string;
  order_ids: string[];
}

/** Marks every unpaid order for `tableId` as paid. Idempotent. */
export async function payForTable(tableId: string): Promise<PayTableResult> {
  const res = await fetch(
    `${MENU_API_BASE}/api/orders/table/${encodeURIComponent(tableId)}/pay`,
    { method: "POST", headers: { Accept: "application/json" } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pay table failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  return {
    table_id: typeof json.table_id === "string" ? json.table_id : tableId,
    paid_at:
      typeof json.paid_at === "string"
        ? json.paid_at
        : new Date().toISOString(),
    order_ids: Array.isArray(json.order_ids) ? json.order_ids.map(String) : [],
  };
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

/**
 * Non-2xx bodies from these two endpoints are always JSON (`{ error: string }`)
 * on a real failure, but would be Express's default HTML 404 page if the
 * route itself didn't exist / the URL was wrong. Try JSON first for a clean
 * message; fall back to the raw (truncated) body so an unexpected HTML page
 * is still visible rather than silently swallowed.
 */
function extractApiErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Not JSON — likely a framework-level error page (e.g. wrong route/method).
  }
  return `HTTP ${status}: ${text.slice(0, 200)}`;
}

/** Manager cancels a dish directly — takes effect immediately. */
export async function cancelOrderItem(
  orderId: string,
  itemId: string,
  reason: string
): Promise<void> {
  const url = `${MENU_API_BASE}/api/orders/${encodeURIComponent(
    orderId
  )}/items/${encodeURIComponent(itemId)}/cancel`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cancel item failed — ${extractApiErrorMessage(res.status, text)}`);
  }
}

/** Manager approves or rejects a cancellation the AI waiter requested. */
export async function resolveCancellationRequest(
  orderId: string,
  itemId: string,
  decision: "approve" | "reject"
): Promise<void> {
  const url = `${MENU_API_BASE}/api/orders/${encodeURIComponent(
    orderId
  )}/items/${encodeURIComponent(itemId)}/resolve-cancellation`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Resolve cancellation failed — ${extractApiErrorMessage(res.status, text)}`
    );
  }
}
