-- ============================================================================
-- SmartWaiter: orders + order_items schema bootstrap
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor (Database → SQL Editor → "New query").
-- Safe to re-run; every statement is guarded.
-- ============================================================================

-- --- orders ------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  table_id text not null,
  status text not null default 'submitted',
  total_price numeric(10, 2) not null default 0,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  guest_note text
);

alter table public.orders add column if not exists table_id text;
alter table public.orders add column if not exists status text;
alter table public.orders add column if not exists total_price numeric(10, 2) not null default 0;
alter table public.orders add column if not exists created_at timestamptz not null default now();
alter table public.orders add column if not exists submitted_at timestamptz;
alter table public.orders add column if not exists ready_at timestamptz;
alter table public.orders add column if not exists served_at timestamptz;
alter table public.orders add column if not exists guest_note text;

-- Historical note: earlier schemas sometimes had `table_id` as integer.
-- The API treats tables as free-form strings (e.g. "T12", "Bar 3"), so
-- coerce to text whenever it isn't already.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'table_id'
      and data_type <> 'text'
  ) then
    alter table public.orders
      alter column table_id type text using table_id::text;
  end if;
end $$;

-- Make every timestamp column on orders / order_items timezone-aware. The
-- backend writes UTC strings; without `timestamptz` JavaScript ends up
-- parsing them as local time, which shows new orders as "overdue"
-- immediately in timezones east of UTC.
do $$
declare r record;
begin
  for r in
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('orders', 'order_items')
      and column_name in (
        'created_at','submitted_at','ready_at','served_at',
        'accepted_at','delivered_at'
      )
      and data_type = 'timestamp without time zone'
  loop
    execute format(
      'alter table public.%I alter column %I type timestamptz using %I at time zone ''UTC''',
      r.table_name, r.column_name, r.column_name
    );
  end loop;
end $$;

-- Give `status` a default + backfill any nulls that might be there.
alter table public.orders alter column status set default 'submitted';
update public.orders set status = 'submitted' where status is null;

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx on public.orders (status);

-- --- order_items -------------------------------------------------------------
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id),
  quantity int not null default 1,
  unit_price numeric(10, 2) not null default 0,
  status text not null default 'pending',
  ready_at timestamptz,
  served_at timestamptz,
  notes text
);

-- Backfill columns for tables that existed before this migration.
alter table public.order_items add column if not exists order_id uuid;
alter table public.order_items add column if not exists menu_item_id uuid;
alter table public.order_items add column if not exists quantity int not null default 1;
alter table public.order_items add column if not exists unit_price numeric(10, 2) not null default 0;
alter table public.order_items add column if not exists status text not null default 'pending';
alter table public.order_items add column if not exists ready_at timestamptz;
alter table public.order_items add column if not exists served_at timestamptz;
alter table public.order_items add column if not exists notes text;

-- Make sure the FKs to orders / menu_items exist (idempotent).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'order_items'
      and constraint_name = 'order_items_order_id_fkey'
  ) then
    alter table public.order_items
      add constraint order_items_order_id_fkey
      foreign key (order_id) references public.orders(id) on delete cascade;
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'order_items'
      and constraint_name = 'order_items_menu_item_id_fkey'
  ) then
    alter table public.order_items
      add constraint order_items_menu_item_id_fkey
      foreign key (menu_item_id) references public.menu_items(id);
  end if;
end $$;

create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists order_items_menu_item_id_idx on public.order_items (menu_item_id);

-- ============================================================================
-- Row-Level Security
-- ----------------------------------------------------------------------------
-- The backend uses the *publishable* (anon) key — same pattern as your
-- existing `menu_items` / `runner_options` tables — so RLS would block all
-- writes. Until you add a real auth layer, disable RLS on these two tables.
-- ============================================================================

alter table public.orders        disable row level security;
alter table public.order_items   disable row level security;
