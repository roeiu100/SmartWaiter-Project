-- ============================================================================
-- SmartWaiter: order item cancellation (manager direct + AI-waiter request)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor AFTER orders_schema.sql.
-- Safe to re-run; every statement is guarded.
--
-- Design: `order_items.status` gains one new legal value, "canceled" (final
-- state — set only once a cancellation actually takes effect). A cancellation
-- REQUEST (filed by the AI waiter on a guest's behalf) is tracked entirely in
-- the separate `cancellation_*` columns below and does NOT touch `status` —
-- so Kitchen/Runner keep treating the item as pending/ready/served, exactly
-- as before, until a manager approves the request (or a manager cancels the
-- item directly, which skips the request step entirely).
-- ============================================================================

alter table public.order_items add column if not exists cancellation_status text not null default 'none';
alter table public.order_items add column if not exists cancellation_reason text;
-- Who INITIATED the cancellation: 'manager' (direct) or 'ai_waiter' (on behalf of the guest).
alter table public.order_items add column if not exists canceled_by text;
-- Set once the item's `status` actually flips to 'canceled'.
alter table public.order_items add column if not exists canceled_at timestamptz;
-- Set when a manager approves or rejects an 'ai_waiter' request (resolves the request either way).
alter table public.order_items add column if not exists cancellation_resolved_at timestamptz;

comment on column public.order_items.cancellation_status is
  'none | requested | approved | rejected. "requested" = AI-waiter filed it, awaiting manager decision. Independent of `status` — see file header.';
comment on column public.order_items.canceled_by is
  'Who initiated the cancellation: manager | ai_waiter. NULL if never canceled/requested.';

create index if not exists order_items_cancellation_status_idx on public.order_items (cancellation_status);
