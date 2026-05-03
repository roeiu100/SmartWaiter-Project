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

/** In-memory blocklist of table ids that may no longer trigger manager alerts. */
const blockedTables = new Set();

/**
 * In-memory list of active runner requests (ketchup, napkins, extra chair, etc.).
 * Persists across Runner dashboard reconnects so nothing is lost if the tablet
 * reloads mid-shift. Cleared via the `clear_runner_alert` socket event.
 */
let activeRunnerAlerts = [];

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

RUNNER REQUESTS (CRITICAL — separate flow from food ordering):
Non-menu service items — e.g. napkins, water, ice, ketchup, mustard, mayo, hot sauce, cutlery, knife, fork, spoon, straws, extra plate, extra chair, extra glass, high chair — are NEVER food cart items. Do NOT call 'update_cart' for them.

Runner request flow:
1. When the guest asks for such an item, DO NOT call any tool yet. In plain text, confirm the item briefly AND ask "Anything else?" in the same reply. Keep the list in conversation memory.
   -> Example: "Napkins coming up. Anything else?"
2. Every subsequent request of this kind: confirm it and keep asking "anything else?".
3. The MOMENT the guest replies "no" / "that's all" / "nothing" (or equivalent in their language), IMMEDIATELY call the 'request_runner' tool ONCE with a single 'request' string that lists every item the guest asked for in this runner session, separated by commas (e.g. "napkins, ketchup"). Your 'guest_reply' must confirm that a runner is on the way. DO NOT ask a follow-up question after calling 'request_runner'.
4. Do NOT mix this flow with 'update_cart' or 'submit_order'. Runner requests and food orders are independent — a guest can do one, the other, or both in the same session.

LANGUAGE: Reply ONLY in the language the user used last.`;

const RUNNER_OPTIONS_FALLBACK = "Napkins, Water, Ketchup";

/**
 * Build the Groq tool definitions for this chat turn. The `request_runner`
 * tool's description is dynamic — it names exactly which table-service
 * items are currently available (from Supabase `runner_options`) so the
 * model doesn't invent things the kitchen can't actually provide.
 */
function buildGroqChatTools(runnerOptionsString) {
  const options =
    typeof runnerOptionsString === "string" && runnerOptionsString.trim() !== ""
      ? runnerOptionsString.trim()
      : RUNNER_OPTIONS_FALLBACK;
  return [
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
  {
    type: "function",
    function: {
      name: "request_runner",
      description: `Dispatch a runner to bring non-menu service items to the guest's table. The ONLY items currently available are: ${options}. Do NOT promise anything outside that list. Call this exactly once, at the moment the guest says they don't need anything else.`,
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description:
              "Short comma-separated list of every runner item requested in this session (e.g. 'napkins, ketchup'). Lowercase, no numbering. Only include items from the allowed list in the tool description.",
          },
          guest_reply: {
            type: "string",
            description:
              "Your short confirmation to the guest that a runner is on the way with the items. Match the guest's last language.",
          },
        },
        required: ["request", "guest_reply"],
      },
    },
  },
];
}
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

/**
 * Fetch the current list of runner (table-service) items that are marked
 * `is_available = true` in Supabase `runner_options`, and return them as a
 * comma-separated string (e.g. "Napkins, Water, Ketchup"). On any error /
 * missing table / empty result, return the safe fallback so the AI still
 * has something to work with.
 */
async function fetchRunnerOptions() {
  try {
    const { data, error } = await supabase
      .from("runner_options")
      .select("name")
      .eq("is_available", true);
    if (error) {
      console.warn(
        "[api/chat] fetchRunnerOptions Supabase error:",
        error.message ?? error
      );
      return RUNNER_OPTIONS_FALLBACK;
    }
    const names = (data ?? [])
      .map((row) => (row && typeof row.name === "string" ? row.name.trim() : ""))
      .filter((n) => n.length > 0);
    if (names.length === 0) return RUNNER_OPTIONS_FALLBACK;
    return names.join(", ");
  } catch (err) {
    console.warn("[api/chat] fetchRunnerOptions threw:", err?.message ?? err);
    return RUNNER_OPTIONS_FALLBACK;
  }
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

app.post("/api/menu", async (req, res) => {
  try {
    const body = req.body ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const categoryRaw =
      typeof body.category === "string" ? body.category.trim() : "";
    const priceNum =
      typeof body.price === "number" ? body.price : Number(body.price);

    if (!name) {
      return res.status(400).json({ error: "Missing or empty 'name'" });
    }
    if (!categoryRaw) {
      return res.status(400).json({ error: "Missing or empty 'category'" });
    }
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({
        error: "'price' must be a non-negative number",
      });
    }

    const description =
      typeof body.description === "string" && body.description.trim() !== ""
        ? body.description.trim()
        : null;

    const isAvailable =
      typeof body.is_available === "boolean" ? body.is_available : true;

    // metadata is a jsonb column; only persist when caller provides an object.
    let metadata = null;
    if (body.metadata && typeof body.metadata === "object") {
      metadata = body.metadata;
    }

    const payload = {
      name,
      description,
      price: priceNum,
      category: categoryRaw.toLowerCase(),
      is_available: isAvailable,
      metadata,
    };

    const { data, error } = await supabase
      .from("menu_items")
      .insert(payload)
      .select("*");

    if (error) {
      console.error("[api/menu POST]", error);
      const status = String(error.code ?? "") === "23505" ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    const inserted = rows[0];
    if (!inserted) {
      return res.status(500).json({ error: "Insert returned no row" });
    }

    if (io) {
      io.emit("menu_updated", {
        menu_item_id: inserted.id,
        is_available: inserted.is_available,
        created: true,
      });
    }

    return res.status(201).json(inserted);
  } catch (err) {
    console.error("[api/menu POST]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.patch("/api/menu/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id ?? "").trim();
    if (!cleanId) {
      return res.status(400).json({ error: "Missing menu item id" });
    }

    const body = req.body ?? {};

    // Only touch fields the caller actually sent so partial updates work
    // and we don't accidentally clear columns to null.
    const patch = {};

    if (typeof body.name === "string") {
      const n = body.name.trim();
      if (!n) {
        return res.status(400).json({ error: "'name' cannot be empty" });
      }
      patch.name = n;
    }

    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      if (body.description == null) {
        patch.description = null;
      } else if (typeof body.description === "string") {
        const d = body.description.trim();
        patch.description = d.length > 0 ? d : null;
      }
    }

    if (body.price !== undefined) {
      const priceNum =
        typeof body.price === "number" ? body.price : Number(body.price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({
          error: "'price' must be a non-negative number",
        });
      }
      patch.price = priceNum;
    }

    if (typeof body.category === "string") {
      const c = body.category.trim();
      if (!c) {
        return res.status(400).json({ error: "'category' cannot be empty" });
      }
      patch.category = c.toLowerCase();
    }

    if (typeof body.is_available === "boolean") {
      patch.is_available = body.is_available;
    }

    if (Object.prototype.hasOwnProperty.call(body, "metadata")) {
      if (body.metadata == null) {
        patch.metadata = null;
      } else if (typeof body.metadata === "object") {
        patch.metadata = body.metadata;
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    const { data, error } = await supabase
      .from("menu_items")
      .update(patch)
      .eq("id", cleanId)
      .select("*");

    if (error) {
      console.error("[api/menu PATCH]", error);
      const status = String(error.code ?? "") === "23505" ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    const updated = rows[0];
    if (!updated) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    if (io) {
      io.emit("menu_updated", {
        menu_item_id: updated.id,
        is_available: updated.is_available,
      });
    }

    return res.json(updated);
  } catch (err) {
    console.error("[api/menu PATCH]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/menu/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id ?? "").trim();
    if (!cleanId) {
      return res.status(400).json({ error: "Missing menu item id" });
    }

    const { data, error } = await supabase
      .from("menu_items")
      .delete()
      .eq("id", cleanId)
      .select("id");

    if (error) {
      console.error("[api/menu DELETE]", error);
      return res.status(500).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    if (io) {
      io.emit("menu_updated", {
        menu_item_id: rows[0].id,
        deleted: true,
      });
    }

    return res.json({ id: rows[0].id, deleted: true });
  } catch (err) {
    console.error("[api/menu DELETE]", err);
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

app.get("/api/runner-options", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("runner_options")
      .select("*")
      .order("name", { ascending: true });

    if (error) {
      console.error("[api/runner-options]", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data ?? []);
  } catch (err) {
    console.error("[api/runner-options]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/runner-options", async (req, res) => {
  try {
    const { name, is_available } = req.body ?? {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) {
      return res.status(400).json({ error: "Missing or empty 'name'" });
    }

    const payload = {
      name: cleanName,
      is_available: typeof is_available === "boolean" ? is_available : true,
    };

    const { data, error } = await supabase
      .from("runner_options")
      .insert(payload)
      .select("id, name, is_available");

    if (error) {
      console.error("[api/runner-options POST]", error);
      // Postgres unique-violation -> 409 so the client can show a friendly message.
      const status = String(error.code ?? "") === "23505" ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    const inserted = rows[0];
    if (!inserted) {
      return res.status(500).json({ error: "Insert returned no row" });
    }

    if (io) {
      io.emit("runner_options_updated", {
        runner_option_id: inserted.id,
        is_available: inserted.is_available,
      });
    }

    return res.status(201).json(inserted);
  } catch (err) {
    console.error("[api/runner-options POST]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/runner-options/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id ?? "").trim();
    if (!cleanId) {
      return res.status(400).json({ error: "Missing runner option id" });
    }

    const { data, error } = await supabase
      .from("runner_options")
      .delete()
      .eq("id", cleanId)
      .select("id");

    if (error) {
      console.error("[api/runner-options DELETE]", error);
      return res.status(500).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return res.status(404).json({ error: "Runner option not found" });
    }

    if (io) {
      io.emit("runner_options_updated", {
        runner_option_id: rows[0].id,
        deleted: true,
      });
    }

    return res.json({ id: rows[0].id, deleted: true });
  } catch (err) {
    console.error("[api/runner-options DELETE]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.patch("/api/runner-options/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id ?? "").trim();
    const { is_available } = req.body;

    if (!cleanId) {
      return res.status(400).json({ error: "Missing runner option id" });
    }

    if (typeof is_available !== "boolean") {
      return res.status(400).json({
        error: "Request body must include is_available as a boolean",
      });
    }

    const { data, error } = await supabase
      .from("runner_options")
      .update({ is_available })
      .eq("id", cleanId)
      .select("id, is_available");

    if (error) {
      console.error("[api/runner-options/:id/availability]", error);
      return res.status(500).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    const updated = rows[0];
    if (!updated) {
      return res.status(404).json({ error: "Runner option not found" });
    }

    if (io) {
      io.emit("runner_options_updated", {
        runner_option_id: updated.id,
        is_available: updated.is_available,
      });
    }

    return res.json({
      runner_option_id: updated.id,
      is_available: updated.is_available,
    });
  } catch (err) {
    console.error("[api/runner-options/:id/availability]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// Orders: persist the full lifecycle in Supabase
// ----------------------------------------------------------------------------
// Guest submission (manual or AI-driven) -> POST /api/orders
// Kitchen / runner status changes        -> PATCH /api/orders/:id/items/:itemId/status
// Kitchen / runner dashboards            -> GET /api/orders/active
//
// Socket.io events broadcast to every client so dashboards stay in sync:
//   - order_created              { order }
//   - order_item_status_changed  { order_id, item_id, status, ready_at?, served_at? }
//   - order_status_changed       { order_id, status, ready_at?, served_at? }
// ============================================================================

const ITEM_STATUSES = new Set(["pending", "ready", "served"]);

function normalizeOrderStatusFromItems(items, previous) {
  if (!Array.isArray(items) || items.length === 0) return previous;
  if (items.every((it) => it.status === "served")) return "delivered";
  if (items.some((it) => it.status === "ready")) return "ready";
  if (items.some((it) => it.status === "pending")) return "preparing";
  return previous;
}

/**
 * Pull the order + its items in a single round-trip using PostgREST's
 * embedded-select syntax. Returned shape:
 *   { ...orderRow, items: [ { ...orderItemRow, menu_item_name } ] }
 */
async function loadFullOrder(orderId) {
  const { data, error } = await supabase
    .from("orders")
    .select(
      `id, table_id, status, total_price, created_at, submitted_at,
       ready_at, served_at, guest_note,
       order_items:order_items (
         id, order_id, menu_item_id, quantity, unit_price, status,
         ready_at, served_at, notes,
         menu_items:menu_items ( id, name )
       )`
    )
    .eq("id", orderId)
    .single();
  if (error) return { error };
  const items = (data?.order_items ?? []).map((it) => ({
    id: it.id,
    order_id: it.order_id,
    menu_item_id: it.menu_item_id,
    quantity: it.quantity,
    unit_price: Number(it.unit_price ?? 0),
    status: it.status,
    ready_at: it.ready_at,
    served_at: it.served_at,
    notes: it.notes,
    menu_item_name: it.menu_items?.name ?? "",
  }));
  const { order_items: _omit, ...orderRow } = data;
  return {
    data: {
      ...orderRow,
      total_price: Number(orderRow.total_price ?? 0),
      items,
    },
  };
}

/**
 * Build and persist an order from a cart-like payload:
 *   { table_id, items: [{ menu_item_id, quantity, notes? }] }
 *
 * Used by both POST /api/orders (manual guest checkout) and the AI
 * submit_order tool call inside /api/chat.
 *
 * Returns `{ order }` on success or `{ error: { status, message } }` on
 * failure so callers can forward consistent HTTP codes.
 */
async function createOrderFromCart(payload) {
  const tableIdRaw =
    payload && typeof payload.table_id === "string" ? payload.table_id : "";
  const table_id = tableIdRaw.trim();
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  if (!table_id) {
    return { error: { status: 400, message: "Missing table_id" } };
  }
  const cleanedLines = [];
  for (const line of rawItems) {
    if (!line || typeof line !== "object") continue;
    const id = typeof line.menu_item_id === "string" ? line.menu_item_id.trim() : "";
    const qty = Number(line.quantity);
    if (!id || !Number.isFinite(qty) || qty <= 0) continue;
    cleanedLines.push({
      menu_item_id: id,
      quantity: Math.floor(qty),
      notes:
        typeof line.notes === "string" && line.notes.trim() !== ""
          ? line.notes.trim()
          : null,
    });
  }
  if (cleanedLines.length === 0) {
    return { error: { status: 400, message: "Cart has no valid items" } };
  }

  // Fetch authoritative prices + availability server-side so clients can't
  // forge totals.
  const ids = [...new Set(cleanedLines.map((l) => l.menu_item_id))];
  const { data: menuRows, error: menuErr } = await supabase
    .from("menu_items")
    .select("id, name, price, is_available")
    .in("id", ids);
  if (menuErr) {
    console.error("[createOrderFromCart] menu lookup error", menuErr);
    return { error: { status: 500, message: menuErr.message } };
  }
  const menuById = new Map((menuRows ?? []).map((m) => [m.id, m]));

  const linesWithPrice = [];
  let total = 0;
  for (const line of cleanedLines) {
    const m = menuById.get(line.menu_item_id);
    if (!m || m.is_available === false) continue;
    const unit_price = Number(m.price ?? 0);
    total += unit_price * line.quantity;
    linesWithPrice.push({ ...line, unit_price });
  }
  if (linesWithPrice.length === 0) {
    return {
      error: {
        status: 400,
        message: "No available items in the cart to send to the kitchen",
      },
    };
  }

  const nowIso = new Date().toISOString();
  const { data: orderInsert, error: orderErr } = await supabase
    .from("orders")
    .insert({
      table_id,
      status: "submitted",
      total_price: Math.round(total * 100) / 100,
      created_at: nowIso,
      submitted_at: nowIso,
    })
    .select("id")
    .single();
  if (orderErr || !orderInsert?.id) {
    console.error("[createOrderFromCart] insert order error", orderErr);
    return {
      error: {
        status: 500,
        message: orderErr?.message ?? "Could not create order",
      },
    };
  }

  const orderId = orderInsert.id;
  const itemsPayload = linesWithPrice.map((l) => ({
    order_id: orderId,
    menu_item_id: l.menu_item_id,
    quantity: l.quantity,
    unit_price: l.unit_price,
    status: "pending",
    notes: l.notes,
  }));
  const { error: itemsErr } = await supabase
    .from("order_items")
    .insert(itemsPayload);
  if (itemsErr) {
    console.error("[createOrderFromCart] insert items error", itemsErr);
    // Clean up the orphan order so a retry doesn't accumulate empties.
    await supabase.from("orders").delete().eq("id", orderId);
    return { error: { status: 500, message: itemsErr.message } };
  }

  const { data: full, error: loadErr } = await loadFullOrder(orderId);
  if (loadErr) {
    console.error("[createOrderFromCart] load full error", loadErr);
    return { error: { status: 500, message: loadErr.message } };
  }

  if (io) io.emit("order_created", full);
  return { order: full };
}

app.post("/api/orders", async (req, res) => {
  try {
    const { order, error } = await createOrderFromCart(req.body ?? {});
    if (error) return res.status(error.status).json({ error: error.message });
    return res.status(201).json(order);
  } catch (err) {
    console.error("[api/orders POST]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/orders/active", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select(
        `id, table_id, status, total_price, created_at, submitted_at,
         ready_at, served_at, guest_note,
         order_items:order_items (
           id, order_id, menu_item_id, quantity, unit_price, status,
           ready_at, served_at, notes,
           menu_items:menu_items ( id, name )
         )`
      )
      .neq("status", "delivered")
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[api/orders/active]", error);
      return res.status(500).json({ error: error.message });
    }
    const rows = (data ?? []).map((row) => {
      const items = (row.order_items ?? []).map((it) => ({
        id: it.id,
        order_id: it.order_id,
        menu_item_id: it.menu_item_id,
        quantity: it.quantity,
        unit_price: Number(it.unit_price ?? 0),
        status: it.status,
        ready_at: it.ready_at,
        served_at: it.served_at,
        notes: it.notes,
        menu_item_name: it.menu_items?.name ?? "",
      }));
      const { order_items: _omit, ...orderRow } = row;
      return {
        ...orderRow,
        total_price: Number(orderRow.total_price ?? 0),
        items,
      };
    });
    return res.json(rows);
  } catch (err) {
    console.error("[api/orders/active]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.patch("/api/orders/:id/items/:itemId/status", async (req, res) => {
  try {
    const orderId = (req.params.id ?? "").trim();
    const itemId = (req.params.itemId ?? "").trim();
    const status = (req.body?.status ?? "").toString().trim();
    if (!orderId || !itemId) {
      return res.status(400).json({ error: "Missing order or item id" });
    }
    if (!ITEM_STATUSES.has(status)) {
      return res.status(400).json({
        error: "Invalid status (expected pending | ready | served)",
      });
    }

    const nowIso = new Date().toISOString();
    const patch = { status };
    if (status === "ready") patch.ready_at = nowIso;
    if (status === "served") patch.served_at = nowIso;

    const { data: itemRows, error: itemErr } = await supabase
      .from("order_items")
      .update(patch)
      .eq("id", itemId)
      .eq("order_id", orderId)
      .select("id");
    if (itemErr) {
      console.error("[api/orders PATCH item]", itemErr);
      return res.status(500).json({ error: itemErr.message });
    }
    if (!itemRows || itemRows.length === 0) {
      return res.status(404).json({ error: "Order item not found" });
    }

    // Recompute parent order status (and stamp ready_at / served_at on
    // the order itself the first time we transition into those states).
    const { data: sibs, error: sibErr } = await supabase
      .from("order_items")
      .select("status")
      .eq("order_id", orderId);
    if (sibErr) {
      console.error("[api/orders PATCH siblings]", sibErr);
      return res.status(500).json({ error: sibErr.message });
    }

    const { data: parent, error: parentErr } = await supabase
      .from("orders")
      .select("status, ready_at, served_at")
      .eq("id", orderId)
      .single();
    if (parentErr || !parent) {
      console.error("[api/orders PATCH parent]", parentErr);
      return res
        .status(parentErr?.code === "PGRST116" ? 404 : 500)
        .json({ error: parentErr?.message ?? "Order not found" });
    }

    const nextStatus = normalizeOrderStatusFromItems(sibs, parent.status);
    const orderPatch = {};
    if (nextStatus !== parent.status) orderPatch.status = nextStatus;
    if (nextStatus === "ready" && !parent.ready_at) orderPatch.ready_at = nowIso;
    if (nextStatus === "delivered" && !parent.served_at) {
      orderPatch.served_at = nowIso;
      if (!parent.ready_at) orderPatch.ready_at = nowIso;
    }
    if (Object.keys(orderPatch).length > 0) {
      const { error: upErr } = await supabase
        .from("orders")
        .update(orderPatch)
        .eq("id", orderId);
      if (upErr) {
        console.error("[api/orders PATCH order]", upErr);
        return res.status(500).json({ error: upErr.message });
      }
    }

    if (io) {
      io.emit("order_item_status_changed", {
        order_id: orderId,
        item_id: itemId,
        status,
        ready_at: status === "ready" ? nowIso : undefined,
        served_at: status === "served" ? nowIso : undefined,
      });
      if (Object.keys(orderPatch).length > 0) {
        io.emit("order_status_changed", {
          order_id: orderId,
          status: nextStatus,
          ready_at: orderPatch.ready_at,
          served_at: orderPatch.served_at,
        });
      }
    }

    return res.json({ ok: true, order_id: orderId, item_id: itemId, status });
  } catch (err) {
    console.error("[api/orders PATCH]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// Analytics: read-only aggregations for the Manager dashboard.
// Every endpoint accepts ?from= & ?to= (ISO dates); both default to a
// rolling 30-day window ending "now". All calculations happen in Node — we
// pull the minimum rows needed and aggregate in-memory so we don't have to
// create SQL views (keeps the setup self-contained).
// ============================================================================

function parseAnalyticsRange(query) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const parseDate = (value, fallback) => {
    if (typeof value !== "string" || value.trim() === "") return fallback;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : d;
  };
  const from = parseDate(query.from, defaultFrom);
  const to = parseDate(query.to, now);
  return { from, to };
}

/** Format a JS Date as an ISO 'YYYY-MM-DD' day bucket (local time). */
function dayKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function diffMinutes(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / 60000;
}

app.get("/api/analytics/summary", async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query ?? {});
    const { data, error } = await supabase
      .from("orders")
      .select("id, total_price, created_at, ready_at, served_at, status")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());
    if (error) {
      console.error("[api/analytics/summary]", error);
      return res.status(500).json({ error: error.message });
    }
    const rows = data ?? [];
    const revenue = rows.reduce((n, o) => n + Number(o.total_price ?? 0), 0);
    const prepDurations = [];
    const deliveryDurations = [];
    for (const o of rows) {
      const prep = diffMinutes(o.created_at, o.ready_at);
      if (prep != null) prepDurations.push(prep);
      const delivery = diffMinutes(o.ready_at, o.served_at);
      if (delivery != null) deliveryDurations.push(delivery);
    }
    const avg = (arr) =>
      arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

    return res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      orders_count: rows.length,
      revenue: Math.round(revenue * 100) / 100,
      avg_order_value:
        rows.length === 0 ? 0 : Math.round((revenue / rows.length) * 100) / 100,
      avg_prep_minutes: avg(prepDurations),
      avg_delivery_minutes: avg(deliveryDurations),
    });
  } catch (err) {
    console.error("[api/analytics/summary]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/analytics/revenue-by-day", async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query ?? {});
    const { data, error } = await supabase
      .from("orders")
      .select("total_price, created_at")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());
    if (error) {
      console.error("[api/analytics/revenue-by-day]", error);
      return res.status(500).json({ error: error.message });
    }
    const buckets = new Map();
    for (const o of data ?? []) {
      const key = dayKey(o.created_at);
      if (!key) continue;
      const entry = buckets.get(key) ?? { day: key, revenue: 0, orders: 0 };
      entry.revenue += Number(o.total_price ?? 0);
      entry.orders += 1;
      buckets.set(key, entry);
    }
    const out = [...buckets.values()]
      .map((b) => ({ ...b, revenue: Math.round(b.revenue * 100) / 100 }))
      .sort((a, b) => a.day.localeCompare(b.day));
    return res.json(out);
  } catch (err) {
    console.error("[api/analytics/revenue-by-day]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/analytics/top-dishes", async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query ?? {});
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit) || 10));
    // Pull the order ids in the window first, then aggregate their items.
    const { data: orderRows, error: orderErr } = await supabase
      .from("orders")
      .select("id")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());
    if (orderErr) {
      console.error("[api/analytics/top-dishes orders]", orderErr);
      return res.status(500).json({ error: orderErr.message });
    }
    const ids = (orderRows ?? []).map((o) => o.id);
    if (ids.length === 0) return res.json([]);
    const { data: itemRows, error: itemErr } = await supabase
      .from("order_items")
      .select("menu_item_id, quantity, unit_price, menu_items:menu_items(name)")
      .in("order_id", ids);
    if (itemErr) {
      console.error("[api/analytics/top-dishes items]", itemErr);
      return res.status(500).json({ error: itemErr.message });
    }
    const byId = new Map();
    for (const it of itemRows ?? []) {
      const mid = it.menu_item_id;
      if (!mid) continue;
      const entry = byId.get(mid) ?? {
        menu_item_id: mid,
        name: it.menu_items?.name ?? "",
        units: 0,
        revenue: 0,
      };
      const q = Number(it.quantity ?? 0);
      entry.units += q;
      entry.revenue += q * Number(it.unit_price ?? 0);
      if (!entry.name && it.menu_items?.name) entry.name = it.menu_items.name;
      byId.set(mid, entry);
    }
    const out = [...byId.values()]
      .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
    return res.json(out);
  } catch (err) {
    console.error("[api/analytics/top-dishes]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/analytics/orders-by-hour", async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query ?? {});
    const { data, error } = await supabase
      .from("orders")
      .select("created_at")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());
    if (error) {
      console.error("[api/analytics/orders-by-hour]", error);
      return res.status(500).json({ error: error.message });
    }
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0 }));
    for (const o of data ?? []) {
      const d = new Date(o.created_at);
      if (Number.isNaN(d.getTime())) continue;
      hours[d.getHours()].orders += 1;
    }
    return res.json(hours);
  } catch (err) {
    console.error("[api/analytics/orders-by-hour]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/analytics/prep-times", async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query ?? {});
    const { data, error } = await supabase
      .from("orders")
      .select("created_at, ready_at, served_at")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString());
    if (error) {
      console.error("[api/analytics/prep-times]", error);
      return res.status(500).json({ error: error.message });
    }
    const buckets = new Map();
    for (const o of data ?? []) {
      const key = dayKey(o.created_at);
      if (!key) continue;
      const entry =
        buckets.get(key) ??
        { day: key, prep: [], delivery: [] };
      const prep = diffMinutes(o.created_at, o.ready_at);
      if (prep != null) entry.prep.push(prep);
      const delivery = diffMinutes(o.ready_at, o.served_at);
      if (delivery != null) entry.delivery.push(delivery);
      buckets.set(key, entry);
    }
    const avg = (arr) =>
      arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
    const out = [...buckets.values()]
      .map((b) => ({
        day: b.day,
        avg_prep_minutes: avg(b.prep),
        avg_delivery_minutes: avg(b.delivery),
      }))
      .sort((a, b) => a.day.localeCompare(b.day));
    return res.json(out);
  } catch (err) {
    console.error("[api/analytics/prep-times]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, table } = req.body ?? {};

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: "JSON body must include an array field `messages` (chat history).",
      });
    }

    const tableKey =
      typeof table === "string" && table.trim() !== "" ? table.trim() : "T?";

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

    const runnerOptions = await fetchRunnerOptions();

    const menuJson = JSON.stringify(menuRows ?? [], null, 2);
    const systemContent = `${SYSTEM_PROMPT}

The following table service items are currently available: ${runnerOptions}. If the guest asks for a runner/table-service item that is NOT in this list, apologise and tell them it is not available — never silently substitute or invent.

--- Current menu_items (JSON; each row has id, name, price, category, is_available, description) ---
${menuJson}`;

    const apiMessages = [
      { role: "system", content: systemContent },
      ...history,
    ];

    const completion = await groq.chat.completions.create({
      model: GROQ_CHAT_MODEL,
      messages: apiMessages,
      tools: buildGroqChatTools(runnerOptions),
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

    // Server-side tools (AI dispatches runner on behalf of the guest).
    // We still return the tool_call to the client so its `guest_reply` can
    // show in the chat bubble, but the side effect (emitting a runner
    // alert) is handled here so the Runner tablet sees it immediately.
    for (const tc of tool_calls) {
      if (tc.name !== "request_runner") continue;
      const args = (tc.arguments ?? {});
      const request =
        typeof args.request === "string" ? args.request.trim() : "";
      if (!request) continue;
      const alert = {
        id: Date.now(),
        table: tableKey,
        request,
        time: new Date().toISOString(),
      };
      activeRunnerAlerts.push(alert);
      console.log("[api/chat] AI request_runner -> new_runner_alert", alert);
      if (io) io.emit("new_runner_alert", alert);
    }

    // submit_order: the AI tells us to ship the cart. The cart is held on
    // the client (authoritative), so we expect the client to have sent the
    // current cart in a parallel /api/orders call (GuestMenu flow) OR, for
    // the chat flow, we accept a `cart` field on the /api/chat request and
    // persist from that. This keeps the server the single writer of the
    // orders table while letting the Chat UI drive it.
    let createdOrder = null;
    let orderError = null;
    const hasSubmitOrder = tool_calls.some((t) => t.name === "submit_order");
    if (hasSubmitOrder) {
      const cart = Array.isArray(req.body?.cart) ? req.body.cart : null;
      if (!cart || cart.length === 0) {
        orderError = {
          status: 400,
          message: "submit_order was requested but no cart was provided",
        };
      } else {
        const result = await createOrderFromCart({
          table_id: tableKey,
          items: cart,
        });
        if (result.error) {
          orderError = result.error;
        } else {
          createdOrder = result.order;
        }
      }
    }

    const hasClientTools = tool_calls.some(
      (t) =>
        t.name === "update_cart" ||
        t.name === "submit_order" ||
        t.name === "request_runner"
    );

    if (hasClientTools) {
      console.log("=== AI'S EXACT TOOL CALLS ===");
      console.log(JSON.stringify(tool_calls, null, 2));
      return res.json({
        text,
        tool_calls,
        order: createdOrder,
        order_error: orderError,
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

/** Broadcast the current blocklist to every connected client. */
function broadcastBlockedTables() {
  const list = Array.from(blockedTables);
  io.emit("blocked_tables_updated", { tables: list });
}

io.on("connection", (socket) => {
  console.log("[socket.io] client connected:", socket.id);

  // Send the current blocklist to this client immediately so a Manager that
  // just (re)connected sees the correct state without waiting for a change.
  socket.emit("blocked_tables_updated", {
    tables: Array.from(blockedTables),
  });

  socket.on("call_manager", (payload, ack) => {
    const respond = (response) => {
      if (typeof ack === "function") ack(response);
    };

    const table =
      payload && typeof payload === "object" ? payload.table : undefined;
    const reason =
      payload && typeof payload === "object" ? payload.reason : undefined;

    if (table == null || String(table).trim() === "") {
      socket.emit("manager_error", {
        code: "invalid_table",
        error: "Missing table id",
      });
      respond({ ok: false, code: "invalid_table" });
      return;
    }

    const tableKey = String(table);

    if (blockedTables.has(tableKey)) {
      console.warn(
        `[socket.io] call_manager blocked for table=${tableKey} (reason=${reason ?? "n/a"})`
      );
      socket.emit("manager_error", {
        code: "table_blocked",
        table: tableKey,
        error: "This table is blocked from calling the manager.",
      });
      respond({ ok: false, code: "table_blocked", table: tableKey });
      return;
    }

    const alert = {
      table: tableKey,
      reason: typeof reason === "string" ? reason : "",
      time: new Date().toISOString(),
    };
    console.log("[socket.io] new_manager_alert", alert);
    io.emit("new_manager_alert", alert);
    respond({ ok: true });
  });

  socket.on("block_table", (payload) => {
    const table =
      payload && typeof payload === "object" ? payload.table : undefined;
    if (table == null || String(table).trim() === "") {
      return;
    }
    const tableKey = String(table);
    if (!blockedTables.has(tableKey)) {
      blockedTables.add(tableKey);
      console.log(`[socket.io] block_table: ${tableKey}`);
      broadcastBlockedTables();
    }
  });

  socket.on("unblock_table", (payload) => {
    const table =
      payload && typeof payload === "object" ? payload.table : undefined;
    if (table == null || String(table).trim() === "") {
      return;
    }
    const tableKey = String(table);
    if (blockedTables.delete(tableKey)) {
      console.log(`[socket.io] unblock_table: ${tableKey}`);
      broadcastBlockedTables();
    }
  });

  // ---------------------------------------------------------------------
  // Runner requests (ketchup, napkins, extra cutlery, etc.)
  // ---------------------------------------------------------------------

  socket.on("call_runner", (data) => {
    const table =
      data && typeof data === "object" ? data.table : undefined;
    const request =
      data && typeof data === "object" ? data.request : undefined;

    if (table == null || String(table).trim() === "") {
      return;
    }

    const alert = {
      id: Date.now(),
      table: String(table),
      request: typeof request === "string" ? request : "",
      time: new Date().toISOString(),
    };
    activeRunnerAlerts.push(alert);
    console.log("[socket.io] new_runner_alert", alert);
    io.emit("new_runner_alert", alert);
  });

  socket.on("get_runner_alerts", () => {
    socket.emit("sync_runner_alerts", activeRunnerAlerts);
  });

  socket.on("clear_runner_alert", (data) => {
    const id = data && typeof data === "object" ? data.id : undefined;
    if (id == null) return;
    activeRunnerAlerts = activeRunnerAlerts.filter((a) => a.id !== id);
    console.log(`[socket.io] clear_runner_alert: id=${id}`);
    io.emit("sync_runner_alerts", activeRunnerAlerts);
  });

  socket.on("disconnect", (reason) => {
    console.log("[socket.io] client disconnected:", socket.id, reason);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `SmartWaiter API + Socket.io listening on http://0.0.0.0:${PORT} (reachable from your LAN)`
  );
});
