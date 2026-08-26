/**
 * PostgreSQL-aligned types for SmartWaiter.
 * These mirror the tables you will create in PostgreSQL; keep them in sync with migrations.
 */

export type UUID = string;

/**
 * jsonb column on menu_items — known fields plus extension keys from the manager UI.
 * `ai_questions` drives waiter modification prompts; omit it when the dish has no choices.
 */
export type MenuItemMetadata = {
  allergens?: string[];
  ingredients?: string[];
  /** e.g. "Ask how they want the burger cooked (rare/med/well) and if they want onions." */
  ai_questions?: string;
} & Record<string, unknown>;

/** Table: menu_items */
export interface MenuItemRow {
  id: UUID;
  name: string;
  price: number;
  category: string;
  /** Second-level grouping within category (e.g. category=food, subcategory=starters|mains). */
  subcategory?: string | null;
  is_available: boolean;
  /** Optional in DB — add column if missing */
  description?: string | null;
  metadata?: MenuItemMetadata | null;
}

/** Payload shape accepted by POST /api/menu when a manager creates a dish. */
export interface MenuItemCreatePayload {
  name: string;
  description?: string | null;
  price: number;
  category: string;
  /** Second-level grouping within category (e.g. category=food, subcategory=starters|mains). */
  subcategory?: string | null;
  is_available?: boolean;
  /** Pass `null` to clear the column (used by PATCH for edits). */
  metadata?: MenuItemMetadata | null;
}

/** Table: orders — order-level status drives kitchen/runner workflows */
export type OrderStatus =
  | "submitted"
  | "preparing"
  | "ready"
  | "delivered"
  | "cancelled";

export interface OrderRow {
  id: UUID;
  table_id: string;
  status: OrderStatus;
  total_price: number;
  /** Set once the guest pays; NULL = still open. See orders_payment_schema.sql. */
  paid_at?: string | null;
}

/** Table: runner_options — non-menu service items (napkins, ketchup, etc.) */
export interface RunnerOptionRow {
  id: UUID;
  name: string;
  is_available: boolean;
}

/** Table: order_items — per-line status (e.g. partial prep) */
export type OrderItemLineStatus = "pending" | "ready" | "served" | "canceled";

/**
 * Cancellation sub-state, independent of `status` above — see
 * backend/sql/order_items_cancellation.sql. "requested" = the AI waiter
 * filed it on the guest's behalf; `status` stays untouched until a manager
 * resolves it. A manager's direct cancel skips straight to "approved".
 */
export type CancellationStatus = "none" | "requested" | "approved" | "rejected";

/** Who initiated a cancellation (direct or requested). */
export type CanceledBy = "manager" | "ai_waiter";

export interface OrderItemRow {
  id: UUID;
  order_id: UUID;
  menu_item_id: UUID;
  status: OrderItemLineStatus;
  /** Add this column in PostgreSQL if you store line qty (recommended). */
  quantity?: number;
  cancellation_status?: CancellationStatus;
  cancellation_reason?: string | null;
  canceled_by?: CanceledBy | null;
  canceled_at?: string | null;
}
