import { MENU_API_BASE } from "./menuApi";

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

export interface ChatCompletionResult {
  assistantText: string;
  tool_calls: ParsedToolCall[];
}

/**
 * POST /api/chat — sends full message history (user + assistant turns only).
 */
export async function sendChatToApi(
  messages: ChatMessage[]
): Promise<ChatCompletionResult> {
  const url = `${MENU_API_BASE}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages }),
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
    const errMsg =
      typeof (json as { error?: string })?.error === "string"
        ? (json as { error: string }).error
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

  return { assistantText, tool_calls };
}
