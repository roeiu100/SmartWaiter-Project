-- ============================================================================
-- SmartWaiter: add subcategory to menu_items (Food -> Starters/Mains split)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

alter table public.menu_items add column if not exists subcategory text;

comment on column public.menu_items.subcategory is
  'Optional second-level grouping within category (e.g. category=food, subcategory=starters|mains). NULL = no subgrouping; item displays directly under its category.';
