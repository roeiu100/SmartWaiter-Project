-- ============================================================================
-- SmartWaiter: add paid_at to orders (Bill / Payment feature)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor AFTER orders_schema.sql.
-- Safe to re-run; every statement is guarded.
-- ============================================================================

alter table public.orders add column if not exists paid_at timestamptz;

-- A table's "active session" = every order where table_id = X AND paid_at IS NULL.
-- This does not touch the existing kitchen/runner `status` lifecycle at all.
create index if not exists orders_table_id_paid_at_idx
  on public.orders (table_id, paid_at);

comment on column public.orders.paid_at is
  'Set by POST /api/orders/table/:tableId/pay when the guest pays. NULL = still open/unpaid.';
