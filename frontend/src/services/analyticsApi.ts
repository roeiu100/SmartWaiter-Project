import { MENU_API_BASE } from "./menuApi";

export interface AnalyticsRange {
  /** ISO-8601 inclusive start. */
  from: string;
  /** ISO-8601 inclusive end. */
  to: string;
}

export interface AnalyticsSummary {
  from: string;
  to: string;
  orders_count: number;
  revenue: number;
  avg_order_value: number;
  avg_prep_minutes: number | null;
  avg_delivery_minutes: number | null;
}

export interface RevenueByDay {
  day: string;
  revenue: number;
  orders: number;
}

export interface TopDish {
  menu_item_id: string;
  name: string;
  units: number;
  revenue: number;
}

export interface OrdersByHour {
  hour: number;
  orders: number;
}

export interface PrepTimesRow {
  day: string;
  avg_prep_minutes: number | null;
  avg_delivery_minutes: number | null;
}

function buildQuery(range: AnalyticsRange, extra?: Record<string, string>) {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
  }
  return `?${params.toString()}`;
}

async function get<T>(path: string, range: AnalyticsRange, extra?: Record<string, string>) {
  const url = `${MENU_API_BASE}${path}${buildQuery(range, extra)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Analytics request failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  return (await res.json()) as T;
}

export const analyticsApi = {
  summary: (range: AnalyticsRange) =>
    get<AnalyticsSummary>("/api/analytics/summary", range),
  revenueByDay: (range: AnalyticsRange) =>
    get<RevenueByDay[]>("/api/analytics/revenue-by-day", range),
  topDishes: (range: AnalyticsRange, limit = 10) =>
    get<TopDish[]>("/api/analytics/top-dishes", range, {
      limit: String(limit),
    }),
  ordersByHour: (range: AnalyticsRange) =>
    get<OrdersByHour[]>("/api/analytics/orders-by-hour", range),
  prepTimes: (range: AnalyticsRange) =>
    get<PrepTimesRow[]>("/api/analytics/prep-times", range),
};
