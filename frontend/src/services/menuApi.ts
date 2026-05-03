import type {
  MenuItemCreatePayload,
  MenuItemRow,
  RunnerOptionRow,
} from "../types/database";

/** Point to your machine’s LAN IP when testing on a device or simulator. */
export const MENU_API_BASE = process.env.EXPO_PUBLIC_API_URL;

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

  const metaRaw = r.metadata;
  const metadata =
    metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, unknown>)
      : null;

  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    price,
    category: String(r.category ?? "General"),
    is_available: r.is_available !== false,
    description,
    metadata,
  };
}

export async function createMenuItem(
  payload: MenuItemCreatePayload
): Promise<MenuItemRow> {
  const res = await fetch(`${MENU_API_BASE}/api/menu`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Create menu item failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  return normalizeMenuItem(await res.json());
}

/**
 * Partial update of a menu item. Only the fields supplied in `payload`
 * are touched on the server.
 */
export async function updateMenuItem(
  id: string,
  payload: Partial<MenuItemCreatePayload>
): Promise<MenuItemRow> {
  const url = `${MENU_API_BASE}/api/menu/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Update menu item failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  return normalizeMenuItem(await res.json());
}

export async function deleteMenuItem(id: string): Promise<void> {
  const url = `${MENU_API_BASE}/api/menu/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Delete menu item failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
}

export async function fetchRunnerOptionsFromApi(): Promise<RunnerOptionRow[]> {
  const res = await fetch(`${MENU_API_BASE}/api/runner-options`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Runner options request failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("Runner options response was not an array");
  }

  return raw.map(normalizeRunnerOption);
}

function normalizeRunnerOption(row: unknown): RunnerOptionRow {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    is_available: r.is_available !== false,
  };
}

export async function createRunnerOption(
  name: string,
  is_available = true
): Promise<RunnerOptionRow> {
  const res = await fetch(`${MENU_API_BASE}/api/runner-options`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, is_available }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Create runner option failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  return normalizeRunnerOption(await res.json());
}

export async function deleteRunnerOption(id: string): Promise<void> {
  const url = `${MENU_API_BASE}/api/runner-options/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Delete runner option failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
}

/**
 * Toggle availability of one runner option. Returns the server's
 * authoritative `{ id, is_available }` so callers can reconcile state.
 */
export async function updateRunnerOptionAvailability(
  id: string,
  is_available: boolean
): Promise<{ id: string; is_available: boolean }> {
  const url = `${MENU_API_BASE}/api/runner-options/${encodeURIComponent(id)}/availability`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ is_available }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Runner option update failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as {
    runner_option_id?: unknown;
    is_available?: unknown;
  };

  return {
    id: String(data.runner_option_id ?? ""),
    is_available: data.is_available === true,
  };
}
