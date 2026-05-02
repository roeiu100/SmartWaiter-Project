process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const path = require("path");
const http = require("http");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const cors = require("cors");
const express = require("express");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const Groq = require("groq-sdk").default;

const app = express();
const PORT = 3000;

/** Set after `new Server(...)` — used from HTTP handlers to push realtime events. */
let io;

// =============================================================================
// SYSTEM_PROMPT — Premium Waiter (Safety + Smart Upselling)
// =============================================================================
const SYSTEM_PROMPT = `You are a premium, intelligent AI waiter. You must drive the conversation forward step-by-step. 

AVAILABILITY RULE (CRITICAL):
Check the 'is_available' flag for EVERY requested item. If an item is false, DO NOT add it to the cart. Apologize, state that it is sold out, and suggest a SPECIFIC item that is currently 'is_available: true' from the menu instead (e.g., "The Burger is sold out today, but our Caesar Salad is available"). NEVER invent or suggest items that do not exist in the menu JSON.

DIETARY SAFETY GUARDIAN (CRITICAL):
If the guest mentions an allergy (e.g., nuts, gluten, dairy) or dietary preference (e.g., vegan), you MUST check the 'metadata' (allergens and ingredients) of the items they order in the menu JSON. If an item contains their allergen, WARN them immediately and suggest a safe alternative. Do NOT add a dangerous item to the cart unless they explicitly confirm it after your warning.

TOOL SURVIVAL RULE (CRITICAL FOR PREVENTING CRASHES):
1. If the guest declines an upsell (e.g., "No thanks" to a drink or side), YOU MUST NOT CALL 'update_cart'. Just reply with plain conversational text asking the next question. NEVER use quantity: 0 just to skip an item!
2. Only use 'update_cart' with quantity: 0 if the guest explicitly asks to REMOVE an item they already ordered in the past.

MEMORY RULE (CRITICAL):
Once you call 'update_cart' for an item, it is permanently saved. DO NOT re-add old items in future turns! If they say "Yes" to fries, ONLY call 'update_cart' for the fries. NEVER call 'update_cart' for the main dish again.

BULK ORDER FAST-TRACK (CRITICAL):
If the guest orders multiple items at once (e.g., "I want a burger, truffle fries, and a coke"), you must SKIP the upselling steps for the items they already provided! 
- Call 'update_cart' for EACH item they mentioned (you can use the tool multiple times in one turn).
- Jump straight to the next logical step. (e.g., If they ordered a main, side, AND drink, jump straight to Step 4 and ask if they want anything else or to send to the kitchen).

ANTI-SKIP RULE (CRITICAL):
You are STRICTLY FORBIDDEN from asking about drinks until you have explicitly asked the guest if they want a side dish.

STRICT 5-STEP ALGORITHM:s
STEP 1 (Modifications): If they order a main dish (e.g., burger), ask ONLY about modifications (e.g., "No onion, extra cheese?"). DO NOT call update_cart yet.
STEP 2 (Smart Side Upsell): When they reply with modifications, call 'update_cart' for the main dish. Look at the menu_items and pick ONE SPECIFIC side dish that pairs perfectly with their main. Your 'guest_reply' MUST confirm the food AND suggest that specific side.
    -> Example: "Got it, a burger with extra cheese. Our Truffle Fries pair perfectly with that—would you like to add that to your order?"
STEP 3 (The Drink Question): When they answer about the side (e.g., "Yes" or "No thanks"), call 'update_cart' for the side (if ordered). Your 'guest_reply' MUST confirm the side AND explicitly ask about drinks.
    -> Example: "Perfect, added the fries. Would you like something to drink with your meal?"
STEP 4 (The Kitchen Question): When they answer about the drink, call 'update_cart' for the drink (if ordered). Your 'guest_reply' MUST confirm the drink AND strictly ask if they want anything else or to send it.
    -> Example: "Got it, one Coca-Cola zero. Would you like anything else, or should I send this to the kitchen?"
STEP 5 (Submit): If they say "no" or "send it", call 'submit_order'. Confirm it was sent.

CRITICAL RULE: EVERY SINGLE MESSAGE YOU SEND MUST END WITH A QUESTION MARK (?) UNTIL THE ORDER IS SENT TO THE KITCHEN. NEVER STOP ASKING QUESTIONS.

LANGUAGE: Reply ONLY in the language the user used last.`;

const GROQ_CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "update_cart",
      description: "Update the guest's cart.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Primary key id of the menu_items row.",
          },
          quantity: {
            type: "integer",
            description: "CRITICAL: Must be a pure mathematical NUMBER (e.g. 1), NEVER a string (e.g. '1'). How many to add.",
          },
          special_requests: {
            type: "string",
            description: "Allergies, preparation notes, or modifiers; use empty string if none.",
          },
          guest_reply: {
            type: "string",
            description: "CRITICAL: Your text response. THIS MUST END WITH A QUESTION MARK. 1. If adding a main, SUGGEST A SPECIFIC SIDE (DO NOT ask about drinks yet!). 2. If adding a side, ask about drinks. 3. If adding a drink, ask to send to kitchen. IF YOU DO NOT END WITH A QUESTION, YOU FAILED.",
          }
        },
        required: ["item_id", "quantity", "special_requests", "guest_reply"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_order",
      description: "Sends the entire current cart to the kitchen. Call this ONLY in Step 5.",
      parameters: {
        type: "object",
        properties: {
          guest_reply: {
            type: "string",
            description: "CRITICAL: Your confirmation message to the guest that the order is being sent.",
          }
        },
        required: ["guest_reply"],
      },
    },
  },
];
/** Groq retired `llama3-70b-8192`; see https://console.groq.com/docs/deprecations */
const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

// Allow any origin (Expo, physical device, emulators) — tighten for production.
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "[smartwaiter-api] Missing SUPABASE_URL or SUPABASE_KEY — check backend/.env"
  );
}

const supabase = createClient(supabaseUrl ?? "", supabaseKey ?? "");

/** Supabase JS sometimes hits transient TLS/network drops (ECONNRESET). */
function isTransientSupabaseNetworkError(error) {
  if (!error || typeof error !== "object") return false;
  const msg = String(error.message ?? "");
  const details = String(error.details ?? "");
  return (
    msg.includes("fetch failed") ||
    details.includes("ECONNRESET") ||
    details.includes("ETIMEDOUT") ||
    details.includes("EPIPE")
  );
}

async function fetchMenuItemsWithRetry() {
  const maxAttempts = 4;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, error } = await supabase.from("menu_items").select("*");
    if (!error) {
      return { data: data ?? [], error: null };
    }
    lastError = error;
    if (!isTransientSupabaseNetworkError(error) || attempt === maxAttempts) {
      break;
    }
    const delayMs = 350 * attempt;
    console.warn(
      `[api/chat] menu_items transient network error (attempt ${attempt}/${maxAttempts}), retry in ${delayMs}ms:`,
      error.message
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { data: null, error: lastError };
}

const groqApiKey = process.env.GROQ_API_KEY;
if (!groqApiKey) {
  console.warn(
    "[smartwaiter-api] Missing GROQ_API_KEY — POST /api/chat will fail until it is set"
  );
}
const groq = new Groq({ apiKey: groqApiKey ?? "" });

app.get("/api/menu", async (req, res) => {
  try {
    const { data, error } = await supabase.from("menu_items").select("*");

    if (error) {
      console.error("[api/menu]", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data ?? []);
  } catch (err) {
    console.error("[api/menu]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.patch("/api/menu/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id ?? "").trim();
    const { is_available } = req.body;

    if (!cleanId) {
      return res.status(400).json({ error: "Missing menu item id" });
    }

    if (typeof is_available !== "boolean") {
      return res.status(400).json({
        error: "Request body must include is_available as a boolean",
      });
    }

    const { data: checkData, error: checkError } = await supabase
      .from("menu_items")
      .select("*")
      .eq("id", cleanId);
    console.log("Pre-update check:", checkData, checkError);

    const { data, error } = await supabase
      .from("menu_items")
      .update({ is_available })
      .eq("id", cleanId)
      .select("id, is_available");

    console.log("Supabase update result:", data, error);

    if (error) {
      console.error("[api/menu/:id/availability]", error);
      return res.status(500).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    const updated = rows[0];
    if (!updated) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    io.emit("menu_updated", {
      menu_item_id: updated.id,
      is_available: updated.is_available,
    });

    return res.json({
      menu_item_id: updated.id,
      is_available: updated.is_available,
    });
  } catch (err) {
    console.error("[api/menu/:id/availability]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body ?? {};

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: "JSON body must include an array field `messages` (chat history).",
      });
    }

    const history = messages
      .filter((m) => m && typeof m === "object")
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content == null
              ? ""
              : JSON.stringify(m.content),
      }));

    const { data: menuRows, error: menuError } =
      await fetchMenuItemsWithRetry();

    if (menuError) {
      console.error("[api/chat] Supabase menu_items error:", menuError);
      return res.status(503).json({
        code: "menu_unavailable",
        error:
          "Could not load the menu (database connection dropped). Please try again in a few seconds.",
      });
    }

    const menuJson = JSON.stringify(menuRows ?? [], null, 2);
    const systemContent = `${SYSTEM_PROMPT}

--- Current menu_items (JSON; each row has id, name, price, category, is_available, description) ---
${menuJson}`;

    const apiMessages = [
      { role: "system", content: systemContent },
      ...history,
    ];

    const completion = await groq.chat.completions.create({
      model: GROQ_CHAT_MODEL,
      messages: apiMessages,
      tools: GROQ_CHAT_TOOLS,
      tool_choice: "auto",
    });

    const choice = completion.choices?.[0];
    const msg = choice?.message;
    const text =
      typeof msg?.content === "string" && msg.content.length > 0
        ? msg.content
        : null;

    const rawToolCalls = msg?.tool_calls ?? [];
    const tool_calls = rawToolCalls.map((tc) => {
      let parsedArgs = null;
      const raw = tc.function?.arguments;
      if (raw === undefined || raw === null) {
        parsedArgs = {};
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed === "" || trimmed === "{}") {
          parsedArgs = {};
        } else {
          try {
            parsedArgs = JSON.parse(trimmed);
          } catch (parseErr) {
            console.error(
              "[api/chat] Failed to parse tool arguments JSON:",
              raw,
              parseErr
            );
            parsedArgs = { _raw: raw, _parseError: String(parseErr) };
          }
        }
      } else if (typeof raw === "object") {
        parsedArgs = raw;
      }
      const fnName = tc.function?.name ?? tc.name ?? null;
      return {
        id: tc.id,
        name: fnName,
        arguments: parsedArgs,
      };
    });

    const hasClientTools = tool_calls.some(
      (t) => t.name === "update_cart" || t.name === "submit_order"
    );

    if (hasClientTools) {
      console.log("=== AI'S EXACT TOOL CALLS ===");
      console.log(JSON.stringify(tool_calls, null, 2));
      return res.json({
        text,
        tool_calls,
      });
    }

    if (text != null) {
      return res.json({ text });
    }

    return res.json({ text: null, tool_calls });
  } catch (err) {
    const status = err?.status;
    if (status === 429) {
      console.warn("[api/chat] Groq rate limit (429):", err?.message ?? err);
      return res.status(429).json({
        code: "rate_limit",
        error:
          "The AI waiter is temporarily unavailable due to usage limits. Please try again in a little while.",
      });
    }
    console.error("[api/chat] Unhandled error:", err?.message ?? err);
    if (err?.stack) {
      console.error("[api/chat] Stack:", err.stack);
    }
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
});

const server = http.createServer(app);

io = new Server(server, {
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  console.log("[socket.io] client connected:", socket.id);
  socket.on("disconnect", (reason) => {
    console.log("[socket.io] client disconnected:", socket.id, reason);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `SmartWaiter API + Socket.io listening on http://0.0.0.0:${PORT} (reachable from your LAN)`
  );
});
