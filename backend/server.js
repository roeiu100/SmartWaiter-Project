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
// SYSTEM_PROMPT — Edit persona, upselling, tone, and strict rules here only.
// Current menu_items from Supabase are appended below this text on each chat.
// =============================================================================
const SYSTEM_PROMPT = `You are a professional, friendly waiter at our restaurant. You speak clearly and warmly, never rush the guest, and you proactively help them feel welcome.

Your goals:
- Answer questions about dishes, ingredients, spice level, and dietary concerns honestly. If you are unsure, say so and suggest they ask the kitchen or manager.
- Help the customer build an order that fits their party size, budget, and preferences. Offer sensible pairings or popular choices when it helps (upsell gently—never pushy).
- Always ground recommendations in the menu data you are given: use exact item names and prices from that list.
- When the customer wants to add, change quantity, or remove an item from their cart, you MUST call the update_cart tool with the correct item_id (UUID from the menu), quantity, and any special_requests (use an empty string if there are none).
- Never invent menu items, prices, or IDs that are not in the provided menu JSON.
- Keep replies concise on mobile; use short paragraphs or bullet lists when comparing options.

Strict rules:
- Do not claim an item is available if the menu shows is_available: false; politely suggest alternatives.
- Do not process payments or personal financial data; you only help with food and drink selection.
- If asked for anything outside the restaurant (legal, medical, unrelated topics), decline briefly and return to the dining experience.`;

/** Groq function-calling: cart updates from the model (schema is fixed; behavior is enforced in the client). */
const GROQ_CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "update_cart",
      description:
        "Update the guest's cart: add or change quantity for a menu item, or set quantity to 0 to remove. Use exact item_id values from the menu_items JSON supplied in the system message.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Primary key id of the menu_items row (UUID string).",
          },
          quantity: {
            type: "number",
            description: "How many of this item (0 removes the line).",
          },
          special_requests: {
            type: "string",
            description:
              "Allergies, preparation notes, or modifiers; use empty string if none.",
          },
        },
        required: ["item_id", "quantity", "special_requests"],
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

    const { data: menuRows, error: menuError } = await supabase
      .from("menu_items")
      .select("*");

    if (menuError) {
      console.error("[api/chat] Supabase menu_items error:", menuError);
      return res.status(500).json({ error: menuError.message });
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
      if (typeof raw === "string") {
        try {
          parsedArgs = JSON.parse(raw);
        } catch (parseErr) {
          console.error(
            "[api/chat] Failed to parse tool arguments JSON:",
            raw,
            parseErr
          );
          parsedArgs = { _raw: raw, _parseError: String(parseErr) };
        }
      }
      return {
        id: tc.id,
        name: tc.function?.name ?? null,
        arguments: parsedArgs,
      };
    });

    const hasUpdateCart = tool_calls.some((t) => t.name === "update_cart");

    if (hasUpdateCart) {
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
