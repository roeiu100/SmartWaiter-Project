import { MENU_API_BASE } from "./menuApi";
import type { ActiveOrder } from "./orderApi";
import { normalizeActiveOrder } from "./orderApi";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ParsedToolCall {
  id?: string;
  name: string | null;
  arguments: Record<string, unknown> | null;
}

export interface ChatCartLine {
  menu_item_id: string;
  quantity: number;
  notes?: string;
}

export interface ChatCompletionResult {
  assistantText: string;
  tool_calls: ParsedToolCall[];
  /** Present when the AI fired `submit_order` and the server persisted it. */
  order: ActiveOrder | null;
  /** Present when `submit_order` fired but the server refused to persist. */
  order_error: { status: number; message: string } | null;
}

/**
 * POST /api/chat — sends full message history (user + assistant turns only).
 * `table` is the current guest table id; the backend uses it when the AI
 * decides to dispatch a runner request (napkins, ketchup, etc.).
 *
 * `cart` is the current client cart. The backend only reads it when the AI
 * returns a `submit_order` tool call — in that case the server persists an
 * order row and echoes it back.
 */
export async function sendChatToApi(
  messages: ChatMessage[],
  table?: string,
  cart?: ChatCartLine[]
): Promise<ChatCompletionResult> {
  const url = `${MENU_API_BASE}/api/chat`;
  const body: {
    messages: ChatMessage[];
    table?: string;
    cart?: ChatCartLine[];
  } = { messages };
  if (typeof table === "string" && table.trim().length > 0) {
    body.table = table.trim();
  }
  if (Array.isArray(cart) && cart.length > 0) {
    body.cart = cart;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let json: unknown;
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(
      `Chat response was not JSON (${res.status}): ${rawText.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    const body = json as { error?: string; code?: string };
    if (res.status === 429 || body.code === "rate_limit") {
      throw new Error(
        typeof body.error === "string" && body.error.length > 0
          ? body.error
          : "The AI waiter is briefly unavailable (usage limit). Please try again soon."
      );
    }
    const errMsg =
      typeof body.error === "string"
        ? body.error
        : rawText.slice(0, 200);
    throw new Error(`Chat request failed (${res.status}): ${errMsg}`);
  }

  const obj = json as Record<string, unknown>;
  const text =
    typeof obj.text === "string"
      ? obj.text
      : obj.text === null
        ? null
        : undefined;

  const rawTools = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
  const tool_calls: ParsedToolCall[] = rawTools.map((t) => {
    const row = t as Record<string, unknown>;
    let args: Record<string, unknown> | null = null;
    const direct = row.arguments;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      args = direct as Record<string, unknown>;
    } else {
      const fn = row.function as Record<string, unknown> | undefined;
      const argStr = fn?.arguments;
      if (typeof argStr === "string") {
        const t = argStr.trim();
        if (t === "" || t === "{}") {
          args = {};
        } else {
          try {
            args = JSON.parse(t) as Record<string, unknown>;
          } catch {
            args = { _raw: argStr };
          }
        }
      } else if (argStr && typeof argStr === "object") {
        args = argStr as Record<string, unknown>;
      }
    }
    const fnBlock = row.function as Record<string, unknown> | undefined;
    const name =
      typeof row.name === "string"
        ? row.name
        : typeof fnBlock?.name === "string"
          ? String(fnBlock.name)
          : null;
    return {
      id: typeof row.id === "string" ? row.id : undefined,
      name,
      arguments: args,
    };
  });

  const assistantText =
    text != null && text.trim().length > 0
      ? text.trim()
      : tool_calls.length > 0
        ? ""
        : "I couldn't generate a reply. Try again.";

  const order = normalizeActiveOrder(obj.order);
  let orderError: ChatCompletionResult["order_error"] = null;
  if (obj.order_error && typeof obj.order_error === "object") {
    const raw = obj.order_error as Record<string, unknown>;
    orderError = {
      status: typeof raw.status === "number" ? raw.status : 500,
      message:
        typeof raw.message === "string" ? raw.message : "Unknown order error",
    };
  }

  return { assistantText, tool_calls, order, order_error: orderError };
}
