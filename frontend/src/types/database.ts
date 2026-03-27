/**
 * PostgreSQL-aligned types for SmartWaiter.
 * These mirror the tables you will create in PostgreSQL; keep them in sync with migrations.
 */

export type UUID = string;

/** Table: menu_items */
export interface MenuItemRow {
  id: UUID;
  name: string;
  price: number;
  category: string;
  is_available: boolean;
  /** Optional in DB — add column if missing */
  description?: string | null;
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
}

/** Table: order_items — per-line status (e.g. partial prep) */
export type OrderItemLineStatus = "pending" | "ready" | "served";

export interface OrderItemRow {
  id: UUID;
  order_id: UUID;
  menu_item_id: UUID;
  status: OrderItemLineStatus;
  /** Add this column in PostgreSQL if you store line qty (recommended). */
  quantity?: number;
}
