import type { MenuItemRow } from "../types/database";

/** Point to your machine’s LAN IP when testing on a device or simulator. */
export const MENU_API_BASE = "http://192.168.1.171:3000";

export async function fetchMenuFromApi(): Promise<MenuItemRow[]> {
  const res = await fetch(`${MENU_API_BASE}/api/menu`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Menu request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("Menu response was not an array");
  }

  return raw.map(normalizeMenuItem);
}

function normalizeMenuItem(row: unknown): MenuItemRow {
  const r = row as Record<string, unknown>;
  const priceRaw = r.price;
  const price =
    typeof priceRaw === "number"
      ? priceRaw
      : parseFloat(String(priceRaw ?? "0")) || 0;

  const desc = r.description;
  const description =
    desc == null || desc === "" ? undefined : String(desc);

  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    price,
    category: String(r.category ?? "General"),
    is_available: r.is_available !== false,
    description,
  };
}
