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
const PORT = Number(process.env.PORT) || 3000;

// Per-stage /api/chat latency breakdown — env-gated, off by default (zero
// cost in normal operation). Set CHAT_TIMING=1 to log context_fetch /
// prompt_build / groq_call / tool_exec timings plus prompt size per
// request; useful for catching future latency regressions without needing
// to re-instrument from scratch.
const CHAT_TIMING = process.env.CHAT_TIMING === "1";
function chatTimingLog(fields) {
  if (!CHAT_TIMING) return;
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[chat-timing] ${parts}`);
}

// Since Node 15, an unhandled promise rejection anywhere in the process
// (a stray fire-and-forget async call, a rejection outside any route's
// try/catch) terminates the whole server by default — one bad AI turn
// should never take down every table's session. Log and keep serving
// instead of crashing.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.stack ?? reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack ?? err);
});

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
// SYSTEM_PROMPT — Persona + operational rules (XML-structured)
// =============================================================================
const SYSTEM_PROMPT = `<persona>
You are the waiter at an upscale, modern restaurant — warm, attentive, and genuinely engaged, the kind of server regulars ask for by name. Speak like a real hospitality professional, not a script: natural conversational transitions ("Excellent choice, the Ribeye is fantastic tonight"), light warmth, confident menu knowledge. Never refer to yourself as an AI, bot, or assistant — you are waitstaff.
You are table-side brief: attentive, but busy. Keep replies tight and natural — a sentence or two of real substance, never a ramble — and always close with a genuine hospitality follow-up that moves the visit forward.
</persona>

<examples>
User: I want a burger. -> Assistant: Excellent choice — how would you like that cooked for you?
</examples>

<operational_instructions>
You are the restaurant's waiter, driving the conversation forward step-by-step with the warmth described above.

AVAILABILITY RULE (CRITICAL): Only offer menu items below. "Sold out" items are NOT available — apologize, confirm it's sold out, suggest one specific available item instead. Never invent an item.

DIETARY SAFETY GUARDIAN (CRITICAL): If the guest mentions an allergy/restriction, check each ordered item's "contains:" tag. On a match, warn immediately and suggest a safe alternative — never add a flagged item unless they explicitly confirm after the warning.

NO INVENTED INGREDIENTS (CRITICAL): You only have item names, prices, and allergen/modification tags — no descriptions. Never state/imply specific ingredients or what a dish "typically" comes with. Acknowledge modification requests (e.g. "no tomato") without inventing what else is on the plate.

TOOL SURVIVAL RULE (CRITICAL — PREVENTS CRASHES): If the guest declines an upsell, do NOT call 'update_cart' — just reply in plain text asking the next question. Never use quantity: 0 to skip an item; only use it when they explicitly ask to remove something already ordered.

NATIVE TOOL CALLING (CRITICAL): Never use XML/HTML tags, markdown fences, or text like <function=update_cart> to call a tool — use the platform's native Tool Calling API only, for update_cart/submit_order/request_runner/request_check/request_item_cancellation. Put your spoken reply in the tool's 'guest_reply' argument, never as plain message text. 'update_cart' arguments are a single flat JSON object (e.g. \`{"item_name": "Ribeye Steak", "quantity": 1}\`) — never an array.

MEMORY RULE (CRITICAL): Once you call 'update_cart' for an item (including the main), it's saved — you won't see that tool call again, only your own past sentences, so track the cart from what you've SAID. Never re-call 'update_cart' for an item already confirmed, even on a short "yes": a "yes" right after you suggest a pairing means "add THAT suggestion," never "re-add the main" (you said "added the burger — might I suggest fries?", guest says "yes" -> add Truffle Fries, not the burger again).

MODIFICATION QUESTIONS (CRITICAL): Items with an "ask:" tag get exactly that one question before 'update_cart' is called for them. No tag = just confirm — never invent a question.

BULK ORDERS (CRITICAL): Multiple items ordered at once — acknowledge the FULL order by name in one sentence (never only the last item), then ask "ask:" questions ONLY for items that carry one (one combined reply if several need it). Don't call 'update_cart' on an item with an unanswered "ask:" tag; items without one may be added right away. If the bulk order already covers a side/drink category, skip that step later; otherwise continue at the next unfulfilled step (side → drink → anything else) — never skip straight to the summary without passing through Step 4.

ANTI-SKIP RULE (CRITICAL): Side/pairing before drink, always. Never suggest a category the cart already has an item from.

UPSELL REASONING (CRITICAL — the menu's category labels, e.g. "Starters:"/"Mains:"/"Drinks:", tell you which section a suggestion belongs to):
- A "pairs_well_with:" tag on the main dish is a curated, restaurant-set pairing — suggest from THAT list first (still side-before-drink, no cart-category dupes). Only use the heuristics below when no tag is present.
- Side before drink, never dessert (see STEP 4). A side must come from "Starters" (or similar) ONLY — never another Main Course item, no matter how light; that's a competing dish, not a side.
- Match the pairing to the KIND of main — distinct categories, don't collapse them:
    - Burger/sandwich/wrap/taco/handheld -> fries-style side, then a casual non-alcoholic drink. Never wine/beer.
    - Pizza -> NEVER fries (duplicates the texture, not how it's served) — salad or garlic-bread-style starter instead, then a casual non-alcoholic drink unless they ask about wine.
    - Red meat -> once the side is settled, red wine if one's on the menu — offer as an option, not a default.
    - Fish/seafood -> white wine if one's on the menu once the side is settled; otherwise a non-alcoholic drink — never substitute red (clashes with fish).
    - Pasta/risotto/rich vegetarian -> salad or vegetable-forward starter, then a casual non-alcoholic drink unless they ask about wine.
- Never duplicate a cart category, never suggest an item not on the menu below.
    -> Bad: fries with pizza (generic fast-food default, wrong here). Bad: another Main Course as a "side." Bad: wine as the first pairing for anything casual. Bad: red wine with fish. Bad: ignoring a "pairs_well_with:" tag for a generic guess.

ORDER STATUS HONESTY (CRITICAL): Before 'submit_order' fires (Step 5), nothing has reached the kitchen — every 'update_cart' confirmation must sound like an in-progress update ("Added the fries to your order"), never completion language ("on its way", "the kitchen has it", "sent through"). Only after 'submit_order' is actually called may you say it's been sent.

STRICT 6-STEP ORDER FLOW:
STEP 1 (Modifications): Ask any "ask:" question for an ordered item, worded exactly as tagged. No tag = just confirm. Don't call 'update_cart' until it's answered.
STEP 2 (Side Pairing): Once modifications are answered (or none needed), call 'update_cart' for the main. Unless the cart already has a side, suggest ONE specific side from "Starters" per UPSELL REASONING — your 'guest_reply' confirms the add AND makes that suggestion. -> "Wonderful, I've added the Ribeye. Might I suggest our truffle fries alongside it?" If the SAME guest message also mentioned a runner item for the first time (napkins, water, etc.), this 'guest_reply' MUST also include its plain-text acknowledgment per RUNNER REQUESTS — see COMPLETE REPLIES FOR MULTI-PART MESSAGES below. -> "Wonderful, I've added the Ribeye. I've noted napkins for you. Might I suggest our truffle fries alongside it?"
STEP 3 (Drink Pairing): If they accept Step 2's side, call 'update_cart' for THAT SIDE (never the main again, per MEMORY RULE); if declined, don't call 'update_cart' (see TOOL SURVIVAL RULE). Unless the cart already has a drink, ask about one and suggest ONE pairing from "Drinks" per UPSELL REASONING — same reply if the side was just accepted.
STEP 4 (Anything Else): Call 'update_cart' for the drink if ordered, confirm it, ask if they'd like anything else. NEVER mention dessert. Decline -> go straight to STEP 5.
STEP 5 (Finish & Send): Check "--- Your current cart ---" below — if non-empty, call 'submit_order' in THIS SAME TURN, no waiting for a second "yes". Any of these IS the confirmation: (a) they decline further items ("no"/"that's all"/"that's it"/similar); (b) they confirm a summary you gave; (c) they directly instruct you to send/submit (any language). Empty cart -> don't call it, just handle whatever else was asked. Before calling 'submit_order', re-scan this ENTIRE conversation (not just the latest message) for any runner/table-service request that hasn't been dispatched yet — if you find one, you MUST call 'submit_order' AND 'request_runner' together in this same turn, never 'request_runner' alone with the cart left unsent.
    -> Example: earlier the guest asked for ketchup/napkins (only acknowledged in text, not yet dispatched) and also has a main dish in the cart; now they say "that's it" — call BOTH 'submit_order' (cart is non-empty) AND 'request_runner' (ketchup, napkins) in this one turn. Firing only 'request_runner' here and leaving the cart unsent is exactly the bug this note exists to prevent.
A runner request (napkins, water, etc.) is a COMPLETELY SEPARATE thread from the food order — dispatching or confirming it NEVER counts as finishing the food order, and never justifies replying about only the runner item while the cart sits unsent. If the cart is non-empty and the guest gave a done signal, 'submit_order' fires this turn regardless of whether a runner request was also involved.
    -> Bad: guest orders a main dish and asks for napkins, then declines a suggested side with "No thanks, that's it" -> replying "Napkins are on the way" and stopping there. The napkin request being handled changes nothing about the main dish still sitting in the cart — 'submit_order' MUST also fire this turn.
'guest_reply' MUST restate the complete itemized order and state it's been sent — e.g. "Here's your order: one Ribeye (medium-rare) and truffle fries. This has been sent to the kitchen." Never claim it's sent before actually calling the tool.

NO REPEATED CONFIRMATIONS (CRITICAL): Once you've said "Added <item>" for something, that's said — never say it again in a later reply, and never re-call 'update_cart' for it (see the cart section below, which always shows the current, already-added state). If the guest's reply doesn't introduce a new item, don't restate an old confirmation as filler — always move the conversation forward instead: continue the 6-step flow (next unresolved step), or, if the cart is non-empty and they've now given you a second signal that they're done (declining again, "good"/"that's it" after already declining once, or anything covered by STEP 5's confirmation list), that means STOP ASKING AND FINALIZE — call 'submit_order' THIS TURN rather than asking "anything else?" yet again. Never let the guest re-decline the same "anything else?" question more than once without calling 'submit_order' if the cart is non-empty.
    -> Bad: guest says "no" to a side/drink offer, cart already has the main -> replying "Added the Ribeye to your order" again (already said, nothing changed) instead of moving to the next step or, if this is their second decline in a row, finalizing.
    -> Bad: asking "anything else?" three times in a row while the guest keeps declining, without ever calling 'submit_order'.

Every message before the order is sent ends with a genuine hospitality follow-up — never a bare "?" tacked onto a non-question.

MULTIPLE TOOLS IN ONE TURN (CRITICAL): One guest message mixing request types -> invoke ALL relevant tools together, never just the first one. This does NOT mean 'request_runner' fires on a brand-new runner item's first mention (see RUNNER REQUESTS step 1 — that's still text-only) — it applies once the runner item is actually eligible for dispatch: a decline/send instruction ("that's it"/"send it") with a runner item pending from earlier in the conversation -> 'submit_order' + 'request_runner' BOTH, even though the runner item wasn't mentioned in this exact message. Item + check request -> the relevant cart tool + 'request_check'. Never handle only the first request and drop the rest.

COMPLETE REPLIES FOR MULTI-PART MESSAGES (CRITICAL): If the guest's message contains more than one distinct ask — a food item AND a runner request, a food item AND a question, etc. — your ONE reply this turn MUST address EVERY part of it. This is about the WORDS in your reply, completely independent of whatever tools you do or don't call this turn: whether you call 'update_cart' (STEP 2), ask a plain-text modifier question with no tool call yet (STEP 1), or anything else, that same reply's words must still cover every other part of the guest's message too (e.g. a runner item's plain-text acknowledgment). Never send a reply that covers only one part and stops, leaving the guest to prompt you again (e.g. saying "And") just to get the rest acknowledged — that is a broken reply, not a valid turn.
    -> Bad: guest says "I want pizza and napkins" -> replying "Added the Margherita Pizza to your order." and stopping there, with no mention of napkins at all until the guest says "And" or otherwise re-raises it. The napkin request was already in the SAME message; it must be acknowledged in this SAME reply.
    -> Good: "Added the Margherita Pizza to your order. I've noted napkins for you. Might I suggest our Caesar Salad alongside it?" — one reply, every part of the guest's message addressed.
    -> Good (no tool call yet, per STEP 1's "ask:" question): guest says "I want a burger and extra napkins" -> "How would you like the burger cooked — rare, medium, or well? I've noted extra napkins for you." — the modifier question AND the runner acknowledgment together, in plain text, before 'update_cart' ever fires.

RUNNER REQUESTS (CRITICAL — separate from food ordering): Non-menu items (napkins, water, ice, condiments, cutlery, extra plate/chair/glass, etc.) are NEVER cart items — never 'update_cart' for them. 1) First such request: confirm in plain text, ask "Anything else?", no tool yet. 2) Keep confirming further requests the same way. 3) On "no"/"that's all"/"nothing" (any language), call 'request_runner' ONCE with every item NOT already listed in "--- Runner requests already sent ---" below, as one comma-separated string. 4) Independent of food ordering, but combine tools when one message covers both (see MULTIPLE TOOLS IN ONE TURN). Before EVER calling 'request_runner', check "--- Runner requests already sent ---" — if the item(s) are already there, do NOT call the tool again and do NOT re-confirm "it's on the way"; that's already handled, just continue the conversation.
A runner item you only acknowledged in TEXT (e.g. "I've noted napkins for you") is NOT dispatched — saying it is not the same as calling the tool, and staff never see it until 'request_runner' actually fires. Whenever the guest's message is a decline/done signal (step 3 above) OR you're calling 'submit_order' this same turn, that is ALWAYS also your cue to check for any such not-yet-dispatched runner item and call 'request_runner' for it right then — never let a turn's reply be only about food (or only 'submit_order') while a runner item mentioned earlier still hasn't gotten its own tool call.
    -> Bad: guest says "pizza and napkins" (napkins only acknowledged in text, per step 1), then later says "no thanks" to a side offer, then "that's it" -> replying with a food-only "anything else?" on the decline, then calling only 'submit_order' (no 'request_runner') on "that's it". The napkins were never dispatched even though two separate "done" signals occurred — exactly the bug this note exists to prevent.

CHECK / BILL REQUESTS (CRITICAL): Guest asks for the check/bill/to pay (any language) -> don't call 'update_cart'/'submit_order'; call 'request_check' ONCE, brief confirmation.

ITEM CANCELLATION REQUESTS (CRITICAL — separate from food ordering): Guest wants to cancel a dish already in "--- Already ordered ---" below (not a still-being-discussed item, which is 'update_cart' quantity 0) -> don't call 'update_cart'. 1) If they already stated why, you have the reason. 2) If not, ask in plain text and wait — don't call 'request_item_cancellation' without one. 3) Once you have a reason, call 'request_item_cancellation' ONCE with the exact item name and that reason in your own words (never a generic placeholder) — this only files a request for manager approval, never promise it's already canceled. Already tagged "[cancellation already requested]" -> tell them it's awaiting review, don't call again.

ORDER STATE IS AUTHORITATIVE, NOT YOUR MEMORY (CRITICAL): "--- Already ordered ---" below is fetched fresh every message — always current, even in a brand-new chat session. For anything about what's ordered/total/cancel, base your answer ONLY on that section — never say a dish "isn't on the order" just because it's not earlier in this chat's history.

LANGUAGE: Reply only in the language the guest used most recently.
</operational_instructions>`;

/** Appended as the final system message before each Groq completion (persona anchor). */
const PERSONA_ANCHOR_SYSTEM_MESSAGE =
  "CRITICAL: Respond to the latest message in your warm, table-side-brief waiter persona, following all operational instructions above. Tool calls (update_cart/submit_order/request_runner/request_check/request_item_cancellation) via native tool calling ONLY — never as <function=...> text.";

const RUNNER_OPTIONS_FALLBACK = "Napkins, Water, Ketchup";

/**
 * OpenAI-compatible tool definitions for Groq chat completions.
 * Passed on every POST /api/chat request via `tools` + `tool_choice: "auto"`.
 */
const GROQ_CHAT_TOOL_UPDATE_CART = {
  type: "function",
  function: {
    name: "update_cart",
    description:
      "Add, update quantity, or remove one menu line on the cart. Native tool calling only. Flat JSON object: item_name, quantity, optional special_requests, guest_reply.",
    parameters: {
      type: "object",
      properties: {
        item_name: {
          type: "string",
          description:
            "Exact menu item name (e.g. \"Ribeye Steak\") — must match a real menu item, never invent one.",
        },
        quantity: {
          type: "number",
          description:
            "The item's NEW TOTAL quantity on the cart, not how many more to add — e.g. if 1 is already in the cart (see the cart section below) and the guest orders one more, pass 2, not 1. Never call this again with the SAME total that's already shown in the cart section; that's a no-op re-confirmation, not a new add. Use 0 only to remove an item already on the cart.",
        },
        special_requests: {
          type: "string",
          description: "Allergies/prep notes/modifiers. Omit if none.",
        },
        guest_reply: {
          type: "string",
          description: "Warm, brief reply for this turn, with a hospitality follow-up when appropriate.",
        },
      },
      required: ["item_name", "quantity", "guest_reply"],
    },
  },
};

const GROQ_CHAT_TOOL_SUBMIT_ORDER = {
  type: "function",
  function: {
    name: "submit_order",
    description:
      "Send the entire cart to the kitchen. Call once the guest is ready to finish AND the cart is non-empty — see STEP 5. Native tool calling only.",
    parameters: {
      type: "object",
      properties: {
        guest_reply: {
          type: "string",
          description:
            "Must restate the complete itemized order and confirm it's been sent — e.g. \"Here's your order: one Ribeye (medium-rare) and a glass of house red. This has been sent to the kitchen.\" Never vague.",
        },
      },
      required: ["guest_reply"],
    },
  },
};

const GROQ_CHAT_TOOL_REQUEST_CHECK = {
  type: "function",
  function: {
    name: "request_check",
    description:
      "Open the guest's Bill screen on a check/bill/pay request. Client-side only, no order data mutated. Native tool calling only.",
    parameters: {
      type: "object",
      properties: {
        guest_reply: {
          type: "string",
          description: "Short confirmation, matching the guest's language.",
        },
      },
      required: ["guest_reply"],
    },
  },
};

const GROQ_CHAT_TOOL_REQUEST_ITEM_CANCELLATION = {
  type: "function",
  function: {
    name: "request_item_cancellation",
    description:
      "File a cancellation request for a dish already in \"--- Already ordered ---\". Does NOT cancel immediately — needs manager approval. Native tool calling only.",
    parameters: {
      type: "object",
      properties: {
        item_name: {
          type: "string",
          description: "Exact name as it appears in \"--- Already ordered ---\".",
        },
        reason: {
          type: "string",
          description:
            "Why, in your own words based on what the guest said. REQUIRED — ask first if not given; never a generic placeholder like \"no reason given\".",
        },
        guest_reply: {
          type: "string",
          description:
            "Warm reply confirming it's flagged for manager review — never say it's already canceled.",
        },
      },
      required: ["item_name", "reason", "guest_reply"],
    },
  },
};

/**
 * Build the full `tools` array for a chat turn. `request_runner` description
 * is dynamic — lists table-service items from Supabase `runner_options`.
 */
function buildGroqChatTools(runnerOptionsString) {
  const options =
    typeof runnerOptionsString === "string" && runnerOptionsString.trim() !== ""
      ? runnerOptionsString.trim()
      : RUNNER_OPTIONS_FALLBACK;

  const GROQ_CHAT_TOOL_REQUEST_RUNNER = {
    type: "function",
    function: {
      name: "request_runner",
      description: `Dispatch a runner for non-menu table service. ONLY available items: ${options}. Call once when done adding requests. Native tool calling only.`,
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "Comma-separated runner items for this session (e.g. 'napkins, ketchup').",
          },
          guest_reply: {
            type: "string",
            description: "Short confirmation a runner is on the way, matching the guest's language.",
          },
        },
        required: ["request", "guest_reply"],
      },
    },
  };

  return [
    GROQ_CHAT_TOOL_UPDATE_CART,
    GROQ_CHAT_TOOL_SUBMIT_ORDER,
    GROQ_CHAT_TOOL_REQUEST_RUNNER,
    GROQ_CHAT_TOOL_REQUEST_CHECK,
    GROQ_CHAT_TOOL_REQUEST_ITEM_CANCELLATION,
  ];
}

/** Groq rejected a completion because the model emitted <function=...> text instead of tool_calls. */
function isGroqToolUseFailedError(err) {
  const msg = String(err?.message ?? err ?? "");
  const body =
    err?.error?.message ??
    err?.response?.data?.error?.message ??
    err?.body?.error?.message ??
    "";
  const combined = `${msg} ${body}`;
  return (
    /tool_use_failed/i.test(combined) ||
    /tool call validation failed/i.test(combined) ||
    /<function=/i.test(combined)
  );
}

/**
 * Call Groq chat completions with tools. On tool_use_failed (XML-style
 * hallucination), retry once with an extra corrective system message.
 */
async function createGroqChatCompletionWithTools({
  model,
  messages,
  tools,
}) {
  const payload = {
    model,
    messages,
    tools,
    tool_choice: "auto",
    // CRITICAL: must stay true. A guest can ask for a kitchen item AND a
    // runner item (or several tools at once) in one message — the server
    // already loops over the full tool_calls array (see /api/chat below),
    // but with this false, Groq caps the model to a single tool call per
    // turn, silently dropping every request after the first.
    parallel_tool_calls: true,
  };
  // NOTE: gpt-oss models expose a reasoning_effort param that measurably
  // cuts hidden reasoning-token spend (verified live: 120 -> 23 reasoning
  // tokens with "low" on a trivial test). Deliberately NOT enabled here —
  // live testing against the actual production system prompt showed
  // reasoning_effort:"low" causes real instruction-following regressions
  // (a STEP 1 violation calling update_cart with a nonsensical quantity: 0
  // before the required "ask:" question was answered, and a separate trial
  // that returned neither text nor a tool call at all) on 2 of 3 identical
  // trials. The token savings are real but not worth the reliability cost
  // for this app's correctness-critical tool-calling flow.

  try {
    return await groq.chat.completions.create(payload);
  } catch (firstErr) {
    if (!isGroqToolUseFailedError(firstErr)) {
      throw firstErr;
    }
    console.warn(
      "[api/chat] tool_use_failed — retrying with native tool-calling reminder:",
      firstErr?.message ?? firstErr
    );
    const retryMessages = [
      ...messages,
      {
        role: "system",
        content:
          "REMINDER: You MUST invoke update_cart, submit_order, request_runner, request_check, and request_item_cancellation using native Tool Calling only. NEVER output <function=name> or <function=name(...)</function> tags or any XML/HTML tool syntax.",
      },
    ];
    return await groq.chat.completions.create({
      ...payload,
      messages: retryMessages,
    });
  }
}
/** Groq retired `llama3-70b-8192`; see https://console.groq.com/docs/deprecations */
const GROQ_CHAT_MODEL = "openai/gpt-oss-120b";

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

/** Category display order for the compact prompt menu — everything else falls after, alphabetically. */
const PROMPT_CATEGORY_ORDER = ["starters", "main courses", "desserts", "drinks"];

function titleCaseCategory(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "Other";
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Formats Supabase menu_items into a compact, token-cheap catalog for the
 * Groq prompt — grouped by category, one line per category, e.g.:
 *   "Starters: Mozzarella Sticks ($7.50), Garlic Bread ($5.00)
 *    Main Courses: Ribeye Steak ($28.00) [ask: how would you like that cooked?]"
 * Deliberately excludes ids (UUIDs), descriptions, and raw metadata/ingredients
 * — those cost tokens without helping the model. The metadata fields that
 * genuinely drive behavior (ai_questions, allergens, recommended_pairings)
 * are kept as short inline tags so the CRITICAL guardrails in SYSTEM_PROMPT
 * ("ask:" / "contains:" / "pairs_well_with:") still have something to read.
 * `metadata.recommended_pairings` (string[] of other menu item names) is
 * optional, restaurant-curated data — when a dish has it set, UPSELL
 * REASONING in SYSTEM_PROMPT is instructed to prefer it over the generic
 * category heuristics (e.g. "pizza -> fries" style guesses). Sold-out items
 * are listed by name only, in one trailing line, so the model still knows
 * they exist (and can apologize + redirect) without spending a
 * token-per-item availability flag.
 */
function formatMenuForPrompt(menuRows) {
  const byCategory = new Map();
  const soldOut = [];

  for (const row of Array.isArray(menuRows) ? menuRows : []) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!name) continue;

    if (row?.is_available === false) {
      soldOut.push(name);
      continue;
    }

    const price = Number(row?.price ?? 0);
    // Group by the more specific subcategory when present (e.g. category=food,
    // subcategory=starters -> "Starters") — the model only needs flat,
    // orderable groups, not the "food" wrapper concept.
    const subcategoryRaw =
      typeof row?.subcategory === "string" ? row.subcategory.trim() : "";
    const category = titleCaseCategory(subcategoryRaw || row?.category);
    const meta =
      row?.metadata && typeof row.metadata === "object" ? row.metadata : null;

    const tags = [];
    const askQuestion =
      meta && typeof meta.ai_questions === "string" ? meta.ai_questions.trim() : "";
    if (askQuestion) tags.push(`ask: ${askQuestion}`);
    const allergens =
      meta && Array.isArray(meta.allergens)
        ? meta.allergens.filter((a) => typeof a === "string" && a.trim())
        : [];
    if (allergens.length > 0) tags.push(`contains: ${allergens.join(", ")}`);
    const pairings =
      meta && Array.isArray(meta.recommended_pairings)
        ? meta.recommended_pairings.filter(
            (p) => typeof p === "string" && p.trim()
          )
        : [];
    if (pairings.length > 0) tags.push(`pairs_well_with: ${pairings.join(", ")}`);
    const tagSuffix = tags.length > 0 ? ` [${tags.join("; ")}]` : "";

    const entry = `${name} ($${price.toFixed(2)})${tagSuffix}`;
    const arr = byCategory.get(category) ?? [];
    arr.push(entry);
    byCategory.set(category, arr);
  }

  const categories = Array.from(byCategory.keys()).sort((a, b) => {
    const ra = PROMPT_CATEGORY_ORDER.indexOf(a.toLowerCase());
    const rb = PROMPT_CATEGORY_ORDER.indexOf(b.toLowerCase());
    const na = ra === -1 ? PROMPT_CATEGORY_ORDER.length : ra;
    const nb = rb === -1 ? PROMPT_CATEGORY_ORDER.length : rb;
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });

  const lines = categories.map((c) => `${c}: ${byCategory.get(c).join(", ")}`);
  if (soldOut.length > 0) {
    lines.push(`Sold out (do not offer): ${soldOut.join(", ")}`);
  }
  return lines.join("\n");
}

const groqApiKey = process.env.GROQ_API_KEY;
if (!groqApiKey) {
  console.warn(
    "[smartwaiter-api] Missing GROQ_API_KEY — POST /api/chat will fail until it is set"
  );
}
// maxRetries: 0 is deliberate, not an oversight. The SDK's default (2
// retries) honors the server's `Retry-After` header on 429s verbatim before
// retrying — measured in production testing at 44s (per-minute limit) up to
// 34+ MINUTES (daily quota limit). That means a single rate-limited request
// could silently hang the guest's HTTP request for up to half an hour
// before finally erroring, which is indistinguishable from "the AI takes
// forever" from the user's side. /api/chat already has its own fast,
// friendly 429 handler (see the outer catch below) — we want that to fire
// in milliseconds, not have the SDK block the response first. A short
// `timeout` similarly bounds worst-case per-attempt duration for any other
// slow/hung network call.
const groq = new Groq({ apiKey: groqApiKey ?? "", maxRetries: 0, timeout: 20_000 });

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
    const subcategoryRaw =
      typeof body.subcategory === "string" ? body.subcategory.trim() : "";
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
      subcategory: subcategoryRaw ? subcategoryRaw.toLowerCase() : null,
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

    if (Object.prototype.hasOwnProperty.call(body, "subcategory")) {
      if (body.subcategory == null) {
        patch.subcategory = null;
      } else if (typeof body.subcategory === "string") {
        const sc = body.subcategory.trim();
        patch.subcategory = sc.length > 0 ? sc.toLowerCase() : null;
      }
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
//   - order_created                        { order }
//   - order_item_status_changed             { order_id, item_id, status, ready_at?, served_at?, cancellation_reason?, canceled_by?, canceled_at?, total_price? }
//   - order_status_changed                  { order_id, status, ready_at?, served_at? }
//   - order_item_cancellation_requested     { order_id, item_id, table_id, menu_item_id, menu_item_name, quantity, reason, requested_at }
//   - order_item_cancellation_resolved      { order_id, item_id, table_id, decision }
// ============================================================================

const ITEM_STATUSES = new Set(["pending", "ready", "served"]);
const ITEM_ORDER_ITEMS_SELECT = `
  id, order_id, menu_item_id, quantity, unit_price, status,
  ready_at, served_at, notes,
  cancellation_status, cancellation_reason, canceled_by, canceled_at,
  menu_items:menu_items ( id, name )
`;

function mapOrderItemRow(it) {
  return {
    id: it.id,
    order_id: it.order_id,
    menu_item_id: it.menu_item_id,
    quantity: it.quantity,
    unit_price: Number(it.unit_price ?? 0),
    status: it.status,
    ready_at: it.ready_at,
    served_at: it.served_at,
    notes: it.notes,
    cancellation_status: it.cancellation_status ?? "none",
    cancellation_reason: it.cancellation_reason ?? null,
    canceled_by: it.canceled_by ?? null,
    canceled_at: it.canceled_at ?? null,
    menu_item_name: it.menu_items?.name ?? "",
  };
}

function normalizeOrderStatusFromItems(items, previous) {
  // Canceled lines don't participate in the parent order's kitchen/runner
  // lifecycle — but if EVERY line ended up canceled, the order itself is
  // canceled too, regardless of whatever kitchen status it had before.
  const all = Array.isArray(items) ? items : [];
  const live = all.filter((it) => it.status !== "canceled");
  if (all.length > 0 && live.length === 0) return "cancelled";
  if (live.length === 0) return previous;
  if (live.every((it) => it.status === "served")) return "delivered";
  if (live.some((it) => it.status === "ready")) return "ready";
  if (live.some((it) => it.status === "pending")) return "preparing";
  return previous;
}

/** Recomputes `orders.total_price` from every non-canceled line and persists it. */
async function recomputeOrderTotal(orderId) {
  const { data: items, error } = await supabase
    .from("order_items")
    .select("unit_price, quantity, status")
    .eq("order_id", orderId);
  if (error) return { error };
  const total = (items ?? [])
    .filter((it) => it.status !== "canceled")
    .reduce((sum, it) => sum + Number(it.unit_price ?? 0) * Number(it.quantity ?? 0), 0);
  const rounded = Math.round(total * 100) / 100;
  const { error: upErr } = await supabase
    .from("orders")
    .update({ total_price: rounded })
    .eq("id", orderId);
  if (upErr) return { error: upErr };
  return { total: rounded };
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
       order_items:order_items ( ${ITEM_ORDER_ITEMS_SELECT} )`
    )
    .eq("id", orderId)
    .single();
  if (error) return { error };
  const items = (data?.order_items ?? []).map(mapOrderItemRow);
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

  // Everything past this point hits Supabase. A thrown exception here
  // (network blip, client-library error that isn't surfaced as `.error`)
  // must not escape as an unhandled rejection — wrap it and hand the caller
  // the same `{ error }` shape as every other failure branch below.
  try {
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
      try {
        await supabase.from("orders").delete().eq("id", orderId);
      } catch (cleanupErr) {
        console.error(
          "[createOrderFromCart] orphan order cleanup failed",
          cleanupErr
        );
      }
      return { error: { status: 500, message: itemsErr.message } };
    }

    const { data: full, error: loadErr } = await loadFullOrder(orderId);
    if (loadErr) {
      console.error("[createOrderFromCart] load full error", loadErr);
      return { error: { status: 500, message: loadErr.message } };
    }

    if (io) io.emit("order_created", full);
    return { order: full };
  } catch (err) {
    console.error("[createOrderFromCart] threw:", err?.message ?? err);
    return {
      error: { status: 500, message: err?.message ?? "Could not create order" },
    };
  }
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
         order_items:order_items ( ${ITEM_ORDER_ITEMS_SELECT} )`
      )
      .neq("status", "delivered")
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[api/orders/active]", error);
      return res.status(500).json({ error: error.message });
    }
    const rows = (data ?? []).map((row) => {
      const items = (row.order_items ?? []).map(mapOrderItemRow);
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

// Unlike /active, this INCLUDES `delivered` orders — a guest who finished
// eating still needs to see/pay their bill. "Unpaid" (paid_at IS NULL) is
// the closest thing this app has to a table "session".
app.get("/api/orders/unpaid", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select(
        `id, table_id, status, total_price, created_at, submitted_at,
         ready_at, served_at, guest_note, paid_at,
         order_items:order_items ( ${ITEM_ORDER_ITEMS_SELECT} )`
      )
      .is("paid_at", null)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[api/orders/unpaid]", error);
      return res.status(500).json({ error: error.message });
    }
    const rows = (data ?? []).map((row) => {
      const items = (row.order_items ?? []).map(mapOrderItemRow);
      const { order_items: _omit, ...orderRow } = row;
      return {
        ...orderRow,
        total_price: Number(orderRow.total_price ?? 0),
        items,
      };
    });
    return res.json(rows);
  } catch (err) {
    console.error("[api/orders/unpaid]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Marks every currently-unpaid order for a table as paid and resets the
// table for the next guest. Idempotent — paying an empty/already-paid table
// still returns 200 with order_ids: [] rather than erroring, so a guest
// double-tapping "Pay Now" can't blow up.
app.post("/api/orders/table/:tableId/pay", async (req, res) => {
  try {
    const tableId = (req.params.tableId ?? "").trim();
    if (!tableId) {
      return res.status(400).json({ error: "Missing table id" });
    }
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("orders")
      .update({ paid_at: nowIso })
      .eq("table_id", tableId)
      .is("paid_at", null)
      .select("id");
    if (error) {
      console.error("[api/orders/table/:tableId/pay]", error);
      return res.status(500).json({ error: error.message });
    }
    const order_ids = (data ?? []).map((r) => r.id);

    if (io) {
      io.emit("table_paid", { table_id: tableId, order_ids, paid_at: nowIso });
    }

    return res.json({ table_id: tableId, paid_at: nowIso, order_ids });
  } catch (err) {
    console.error("[api/orders/table/:tableId/pay]", err);
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
      .neq("status", "canceled")
      .select("id");
    if (itemErr) {
      console.error("[api/orders PATCH item]", itemErr);
      return res.status(500).json({ error: itemErr.message });
    }
    if (!itemRows || itemRows.length === 0) {
      return res.status(404).json({ error: "Order item not found (or already canceled)" });
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

/**
 * Recomputes and persists the parent order's `status` after an item's
 * lifecycle changed (shared by the plain status PATCH above and the two
 * cancellation endpoints below, which also need to re-derive it).
 */
async function syncOrderStatusAfterItemChange(orderId, nowIso) {
  const { data: sibs, error: sibErr } = await supabase
    .from("order_items")
    .select("status")
    .eq("order_id", orderId);
  if (sibErr) return { error: sibErr };

  const { data: parent, error: parentErr } = await supabase
    .from("orders")
    .select("status, ready_at, served_at")
    .eq("id", orderId)
    .single();
  if (parentErr || !parent) {
    return { error: parentErr ?? new Error("Order not found") };
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
    if (upErr) return { error: upErr };
  }
  return { nextStatus, orderPatch };
}

// ============================================================================
// Order item cancellation
// ----------------------------------------------------------------------------
//   - PATCH /api/orders/:id/items/:itemId/cancel               manager direct cancel (immediate)
//   - POST  /api/orders/:id/items/:itemId/resolve-cancellation  manager approve/reject an AI-waiter request
//   - requestItemCancellationByName(...)                        used by the AI's request_item_cancellation tool call
// ============================================================================

// Manager cancels a dish directly — takes effect immediately, no approval step.
app.patch("/api/orders/:id/items/:itemId/cancel", async (req, res) => {
  try {
    const orderId = (req.params.id ?? "").trim();
    const itemId = (req.params.itemId ?? "").trim();
    const reason = (req.body?.reason ?? "").toString().trim();
    if (!orderId || !itemId) {
      return res.status(400).json({ error: "Missing order or item id" });
    }
    if (!reason) {
      return res.status(400).json({ error: "A cancellation reason is required" });
    }

    const nowIso = new Date().toISOString();
    const { data: itemRow, error: itemErr } = await supabase
      .from("order_items")
      .update({
        status: "canceled",
        cancellation_status: "approved",
        cancellation_reason: reason,
        canceled_by: "manager",
        canceled_at: nowIso,
        cancellation_resolved_at: nowIso,
      })
      .eq("id", itemId)
      .eq("order_id", orderId)
      .neq("status", "canceled")
      .select("id")
      .single();
    if (itemErr) {
      if (itemErr.code === "PGRST116") {
        return res.status(404).json({ error: "Order item not found (or already canceled)" });
      }
      console.error("[api/orders cancel item]", itemErr);
      return res.status(500).json({ error: itemErr.message });
    }

    const { total, error: totalErr } = await recomputeOrderTotal(orderId);
    if (totalErr) {
      console.error("[api/orders cancel item] recomputeOrderTotal", totalErr);
      return res.status(500).json({ error: totalErr.message });
    }

    const { nextStatus, orderPatch, error: syncErr } =
      await syncOrderStatusAfterItemChange(orderId, nowIso);
    if (syncErr) {
      console.error("[api/orders cancel item] syncOrderStatusAfterItemChange", syncErr);
      return res
        .status(500)
        .json({ error: syncErr.message ?? "Could not update order status" });
    }

    if (io) {
      io.emit("order_item_status_changed", {
        order_id: orderId,
        item_id: itemId,
        status: "canceled",
        cancellation_reason: reason,
        canceled_by: "manager",
        canceled_at: nowIso,
        total_price: total,
      });
      if (orderPatch && Object.keys(orderPatch).length > 0) {
        io.emit("order_status_changed", {
          order_id: orderId,
          status: nextStatus,
          ready_at: orderPatch.ready_at,
          served_at: orderPatch.served_at,
        });
      }
    }

    return res.json({
      ok: true,
      order_id: orderId,
      item_id: itemId,
      status: "canceled",
      total_price: total,
    });
  } catch (err) {
    console.error("[api/orders cancel item]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Manager approves or rejects a cancellation the AI waiter filed on a
// guest's behalf. Approve => same effect as a direct cancel (item stays
// attributed to whoever originally requested it via `canceled_by`).
// Reject => item stays active; the rejection itself is logged via
// cancellation_status='rejected' + cancellation_resolved_at.
app.post("/api/orders/:id/items/:itemId/resolve-cancellation", async (req, res) => {
  try {
    const orderId = (req.params.id ?? "").trim();
    const itemId = (req.params.itemId ?? "").trim();
    const decision = (req.body?.decision ?? "").toString().trim().toLowerCase();
    if (!orderId || !itemId) {
      return res.status(400).json({ error: "Missing order or item id" });
    }
    if (decision !== "approve" && decision !== "reject") {
      return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    }

    const nowIso = new Date().toISOString();
    const patch =
      decision === "approve"
        ? {
            status: "canceled",
            cancellation_status: "approved",
            canceled_at: nowIso,
            cancellation_resolved_at: nowIso,
          }
        : { cancellation_status: "rejected", cancellation_resolved_at: nowIso };

    const { data: itemRow, error: itemErr } = await supabase
      .from("order_items")
      .update(patch)
      .eq("id", itemId)
      .eq("order_id", orderId)
      .eq("cancellation_status", "requested")
      .select("id, cancellation_reason")
      .single();
    if (itemErr) {
      if (itemErr.code === "PGRST116") {
        return res
          .status(404)
          .json({ error: "No pending cancellation request found for this item" });
      }
      console.error("[api/orders resolve-cancellation]", itemErr);
      return res.status(500).json({ error: itemErr.message });
    }

    let total = null;
    let nextStatus = null;
    let orderPatch = {};
    if (decision === "approve") {
      const totalResult = await recomputeOrderTotal(orderId);
      if (totalResult.error) {
        console.error(
          "[api/orders resolve-cancellation] recomputeOrderTotal",
          totalResult.error
        );
        return res.status(500).json({ error: totalResult.error.message });
      }
      total = totalResult.total;

      const syncResult = await syncOrderStatusAfterItemChange(orderId, nowIso);
      if (syncResult.error) {
        console.error(
          "[api/orders resolve-cancellation] syncOrderStatusAfterItemChange",
          syncResult.error
        );
        return res
          .status(500)
          .json({ error: syncResult.error.message ?? "Could not update order status" });
      }
      nextStatus = syncResult.nextStatus;
      orderPatch = syncResult.orderPatch ?? {};
    }

    if (io) {
      io.emit("order_item_cancellation_resolved", {
        order_id: orderId,
        item_id: itemId,
        decision,
      });
      if (decision === "approve") {
        io.emit("order_item_status_changed", {
          order_id: orderId,
          item_id: itemId,
          status: "canceled",
          cancellation_reason: itemRow.cancellation_reason,
          canceled_at: nowIso,
          total_price: total,
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
    }

    return res.json({
      ok: true,
      order_id: orderId,
      item_id: itemId,
      decision,
      total_price: total,
    });
  } catch (err) {
    console.error("[api/orders resolve-cancellation]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Every order_item on a table's currently-open (unpaid) orders — the single
 * authoritative "what has this table actually ordered" list, straight from
 * the DB. Used for TWO things that must never disagree with each other:
 *   1. Grounding the AI's prompt on every /api/chat turn (see
 *      formatOrderStateForPrompt) — so a guest reopening the app and
 *      starting a brand-new chat session doesn't make the AI "forget"
 *      dishes it already sent to the kitchen. Conversation history is NOT
 *      a reliable source of this; it resets on every fresh session while
 *      the order itself lives on in Postgres.
 *   2. Resolving `request_item_cancellation` by dish name (the AI only
 *      knows a name, not an order/item id).
 * Returned oldest-first; callers that want "most recent match" should scan
 * from the end.
 */
async function fetchActiveTableOrderItems(tableId) {
  const table = (tableId ?? "").toString().trim();
  if (!table) return { items: [] };

  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select(
        `id, table_id, created_at,
         order_items:order_items (
           id, order_id, menu_item_id, quantity, unit_price, status, cancellation_status,
           menu_items:menu_items ( id, name )
         )`
      )
      .eq("table_id", table)
      .is("paid_at", null)
      .order("created_at", { ascending: true });
    if (error) return { items: [], error };

    const items = [];
    for (const order of orders ?? []) {
      for (const it of order.order_items ?? []) {
        items.push({
          orderId: order.id,
          itemId: it.id,
          menuItemId: it.menu_item_id,
          name: it.menu_items?.name ?? "",
          quantity: it.quantity,
          unitPrice: Number(it.unit_price ?? 0),
          status: it.status,
          cancellationStatus: it.cancellation_status ?? "none",
        });
      }
    }
    return { items };
  } catch (err) {
    // Network blip / Supabase client throw (not just an `.error` field) —
    // fail soft with an empty order list rather than letting this bubble up
    // and abort the whole /api/chat turn.
    console.warn(
      "[fetchActiveTableOrderItems] threw:",
      err?.message ?? err
    );
    return { items: [], error: err };
  }
}

/**
 * Renders fetchActiveTableOrderItems() output into the compact block
 * injected into the AI's system prompt on every turn (see /api/chat). Non-
 * canceled lines only — a canceled dish is simply gone, not "in the order".
 */
function formatOrderStateForPrompt(items) {
  const live = (items ?? []).filter((it) => it.status !== "canceled");
  if (live.length === 0) {
    return "Nothing has been ordered yet for this table.";
  }
  let total = 0;
  const lines = live.map((it) => {
    const lineTotal = it.unitPrice * it.quantity;
    total += lineTotal;
    const pendingTag =
      it.cancellationStatus === "requested"
        ? " [cancellation already requested — awaiting manager approval; do NOT request again]"
        : "";
    return `${it.quantity}x ${it.name} ($${lineTotal.toFixed(2)}, ${it.status})${pendingTag}`;
  });
  lines.push(`Current order total so far: $${total.toFixed(2)}`);
  return lines.join("\n");
}

/**
 * Renders the guest's client-side, not-yet-submitted cart into the same
 * kind of compact block used for the menu / already-ordered sections. The
 * client already sends this on every /api/chat call (see chatApi.ts), but
 * it was previously only read once `submit_order` fired — the model itself
 * never saw it, and had to infer "what's already in the cart" purely from
 * its own past prose. That's what caused it to re-call 'update_cart' on the
 * main dish again instead of the side/drink the guest had just accepted:
 * with no structured ground truth, a short "yes" is genuinely ambiguous.
 * Grounding this every turn — exactly like the menu and the already-ordered
 * section — removes that ambiguity.
 */
function formatCartForPrompt(cartLines, menuRows) {
  const menuById = new Map((menuRows ?? []).map((m) => [m.id, m]));
  const lines = (Array.isArray(cartLines) ? cartLines : [])
    .map((l) => {
      const qty = Number(l?.quantity ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) return null;
      const menuItemId =
        typeof l?.menu_item_id === "string" ? l.menu_item_id : "";
      const name = menuById.get(menuItemId)?.name ?? null;
      if (!name) return null;
      const notes =
        typeof l?.notes === "string" && l.notes.trim()
          ? ` (${l.notes.trim()})`
          : "";
      return `${qty}x ${name}${notes}`;
    })
    .filter(Boolean);
  if (lines.length === 0) {
    return "Nothing has been added to the cart yet this session.";
  }
  return lines.join("\n");
}

/**
 * Resolves an `update_cart`/`submit_order`-adjacent item_name string back to
 * a real menu_item id, mirroring `resolveMenuItemId` in the frontend's
 * ChatScreen.tsx (exact match first, then a loose substring match for minor
 * paraphrasing) — needed server-side by the duplicate-add guard below, which
 * has to compare the model's item_name against the client's cart (keyed by
 * menu_item_id, not by name).
 */
function resolveMenuItemIdByName(menuRows, itemName) {
  const target = (itemName ?? "").toString().trim().toLowerCase();
  if (!target) return null;
  const rows = Array.isArray(menuRows) ? menuRows : [];
  const exact = rows.find((m) => (m.name ?? "").trim().toLowerCase() === target);
  if (exact) return exact.id;
  const loose = rows.find((m) => {
    const n = (m.name ?? "").trim().toLowerCase();
    return n && (n.includes(target) || target.includes(n));
  });
  return loose ? loose.id : null;
}

/**
 * A bare "no"/"nope"/"nah" (with or without a polite "thanks" tail) only
 * rejects the item/question just offered — mid-flow (e.g. declining a side
 * while the drink question hasn't been asked yet), that's not proof the
 * guest is done ordering overall, so the STEP 5 backstop treats these as a
 * WEAK signal requiring corroboration (see `isStrongDoneSignal` below).
 */
const WEAK_DECLINE_ALONE = new Set(["no", "nope", "nah", "no thanks", "no thank you"]);

/**
 * Explicit full-stop phrasing ("that's it", "nothing else", "all set", "I'm
 * done", etc, with or without a leading "no" and/or trailing "thanks") is
 * unambiguous regardless of what question it's answering — declining a
 * specific upsell item (e.g. "No thanks, that's it" after being offered a
 * Caesar Salad) with this wording is just as final as answering a plain
 * "anything else?" the same way. STEP 5 in SYSTEM_PROMPT already lists these
 * as needing no second confirmation, so the backstop honors that on the
 * first occurrence — see `isStrongDoneSignal` below.
 */
const STRONG_DONE_CORE_PHRASES = new Set([
  "nothing else",
  "nothing more",
  "that's all",
  "that is all",
  "that'll be all",
  "that will be all",
  "that's it",
  "that is it",
  "that's everything",
  "that covers it",
  "all set",
  "we're all set",
  "we are all set",
  "i'm all set",
  "i am all set",
  "i'm good",
  "i am good",
  "we're good",
  "we are good",
  "i'm done",
  "i am done",
  "we're done",
  "we are done",
]);

function normalizeDeclineText(text) {
  return (text ?? "")
    .toString()
    .trim()
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[!.?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Strips an optional leading "no"/"nope"/"nah" and an optional trailing
// "thanks"/"thank you"/"please" so compound phrasing like "No, that's it,
// thanks" or "Nope, all set" reduces to the core closing phrase for matching
// against STRONG_DONE_CORE_PHRASES.
function stripDeclineFiller(normalized) {
  return normalized
    .replace(/^(no|nope|nah)\b[,]?\s*/, "")
    .replace(/\s*[,]?\s*(thanks|thank you|please)$/, "")
    .trim();
}

/**
 * True only for an explicit, unambiguous "I'm completely done" phrase —
 * never for a bare "no" alone, since that could just be declining the one
 * item/question just offered. Used by the STEP 5 finalization backstop to
 * finalize a non-empty cart on the FIRST such signal, without waiting for a
 * second decline or a `request_runner` call as corroboration.
 */
function isStrongDoneSignal(text) {
  const raw = (text ?? "").toString().trim();
  if (!raw) return false;
  const rawNoPunct = raw.replace(/[.!?]+$/g, "").trim();
  if (/^(זהו|סיימתי)$/i.test(rawNoPunct)) return true;
  return STRONG_DONE_CORE_PHRASES.has(stripDeclineFiller(normalizeDeclineText(raw)));
}

/**
 * Guest reply text that means "no more items, I'm done" (weak OR strong —
 * see above) — mirrors `userDeclinesFurtherItems` in the frontend's
 * ChatScreen.tsx. Duplicated (not imported) because the backend is a
 * separate Node process/deploy from the RN app; used by the STEP 5
 * finalization backstop in /api/chat (see doc comment there) to detect when
 * the model should have called 'submit_order' but didn't.
 */
function isDeclineFurtherItemsPhrase(text) {
  const raw = (text ?? "").toString().trim();
  if (!raw) return false;
  const rawNoPunct = raw.replace(/[.!?]+$/g, "").trim();
  if (/^לא(\s+תודה)?$/i.test(rawNoPunct)) return true;
  if (/^(זהו|סיימתי)$/i.test(rawNoPunct)) return true;

  const t = normalizeDeclineText(raw);
  if (WEAK_DECLINE_ALONE.has(t)) return true;
  return STRONG_DONE_CORE_PHRASES.has(stripDeclineFiller(t));
}

/**
 * Builds a deterministic, itemized "sent to the kitchen" guest_reply for the
 * STEP 5 finalization backstop (see /api/chat) — used only when the backstop
 * itself calls createOrderFromCart because the model failed to call
 * 'submit_order' on its own, so there is no model-authored guest_reply to
 * fall back on. Mirrors the phrasing the SYSTEM_PROMPT requires from the
 * model's own 'submit_order' guest_reply ("Here's your order: ...This has
 * been sent to the kitchen.") so the guest sees a consistent message
 * regardless of which path actually finalized the order.
 */
function buildForcedFinalizeGuestReply(clientCart, menuRows, lang) {
  const menuById = new Map((menuRows ?? []).map((m) => [m.id, m]));
  const parts = (Array.isArray(clientCart) ? clientCart : [])
    .map((l) => {
      const qty = Number(l?.quantity ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) return null;
      const name = menuById.get(l?.menu_item_id)?.name;
      if (!name) return null;
      return qty === 1 ? name : `${qty}x ${name}`;
    })
    .filter(Boolean);
  const itemsText = parts.join(", ");
  if (lang === "he") {
    return itemsText
      ? `הנה ההזמנה שלכם: ${itemsText}. ההזמנה נשלחה למטבח.`
      : "ההזמנה נשלחה למטבח.";
  }
  return itemsText
    ? `Here's your order: ${itemsText}. This has been sent to the kitchen.`
    : "This has been sent to the kitchen.";
}

/**
 * Guest reply text for the RUNNER REQUEST finalization backstop (see
 * /api/chat) — used only when the backstop itself dispatches
 * 'request_runner' because the model never called it, so there's no
 * model-authored guest_reply to fall back on.
 */
function buildForcedRunnerGuestReply(items, lang) {
  const itemsText = (Array.isArray(items) ? items : []).join(", ");
  if (lang === "he") {
    return itemsText ? `${itemsText} בדרך אליכם.` : "זה בדרך אליכם.";
  }
  return itemsText ? `${itemsText} on the way.` : "That's on the way.";
}

/**
 * Used by the AI waiter's `request_item_cancellation` tool call — it only
 * knows a table id and a dish name, not an order/item id, so this resolves
 * the most recently-placed, still-active (non-canceled, not already
 * pending) matching line for that table and files the request against it.
 * Does NOT touch `status` or the order total — see the schema comment in
 * backend/sql/order_items_cancellation.sql for why.
 */
async function requestItemCancellationByName({ tableId, itemName, reason }) {
  const table = (tableId ?? "").toString().trim();
  const name = (itemName ?? "").toString().trim();
  if (!table || !name) {
    return { error: { message: "Missing table or item name" } };
  }

  const { items, error: fetchErr } = await fetchActiveTableOrderItems(table);
  if (fetchErr) {
    return { error: fetchErr };
  }

  const needle = name.toLowerCase();
  let match = null;
  // Items are oldest-first; scan backwards to prefer the most recently
  // placed matching dish (e.g. two rounds of the same burger).
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const itName = it.name.trim().toLowerCase();
    if (!itName || itName !== needle) continue;
    if (it.status === "canceled") continue;
    if (it.cancellationStatus === "requested") continue;
    match = it;
    break;
  }
  if (!match) {
    return {
      error: {
        message: `No active order item named "${name}" found for table ${table}`,
      },
    };
  }

  const nowIso = new Date().toISOString();
  const cleanReason = (reason ?? "").toString().trim() || "No reason given";
  const { error: updErr } = await supabase
    .from("order_items")
    .update({
      cancellation_status: "requested",
      cancellation_reason: cleanReason,
      canceled_by: "ai_waiter",
    })
    .eq("id", match.itemId);
  if (updErr) {
    return { error: updErr };
  }

  if (io) {
    io.emit("order_item_cancellation_requested", {
      order_id: match.orderId,
      item_id: match.itemId,
      table_id: table,
      menu_item_id: match.menuItemId,
      menu_item_name: match.name,
      quantity: match.quantity,
      reason: cleanReason,
      requested_at: nowIso,
    });
  }

  return { ok: true, order_id: match.orderId, item_id: match.itemId };
}

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

/**
 * Executes the server-side effect of a single AI tool call from /api/chat
 * (runner alert, cancellation request, or kitchen order submission).
 *
 * CRITICAL: the caller MUST run this over every entry in `tool_calls` via
 * `Promise.all` (not just tool_calls[0], and not sequentially) — a guest
 * turn frequently mixes multiple tools at once (e.g. "send the Salmon and
 * Lemonade to the kitchen and bring some ketchup" = submit_order AND
 * request_runner together). Handling only the first call, or awaiting them
 * one-by-one such that an early failure short-circuits the rest, is exactly
 * the bug this function exists to prevent. Each call is independently
 * try/caught so one hallucinated/malformed call can't take down the others.
 */
async function executeChatToolCall(tc, { tableKey, clientCart }) {
  const name = tc?.name;
  try {
    switch (name) {
      case "request_runner": {
        const args = tc.arguments ?? {};
        const request =
          typeof args.request === "string" ? args.request.trim() : "";
        if (!request) return { name };
        // Hard backstop against duplicate dispatches: the system prompt
        // shows the model what's already been sent (see the "Runner
        // requests already sent" section in /api/chat), but that's a
        // best-effort instruction, not a guarantee — this model has been
        // observed re-calling a tool for something already handled several
        // turns back. An identical, still-active request for the same
        // table must never create a second real alert regardless of why
        // the model called it again.
        const alreadyActive = activeRunnerAlerts.some(
          (a) =>
            a.table === tableKey &&
            a.request.trim().toLowerCase() === request.toLowerCase()
        );
        if (alreadyActive) {
          console.log(
            `[api/chat] request_runner suppressed duplicate for table ${tableKey}: "${request}" already active`
          );
          return { name, duplicate: true };
        }
        const alert = {
          id: Date.now(),
          table: tableKey,
          request,
          time: new Date().toISOString(),
        };
        activeRunnerAlerts.push(alert);
        console.log("[api/chat] AI request_runner -> new_runner_alert", alert);
        if (io) io.emit("new_runner_alert", alert);
        return { name, alert };
      }

      case "request_item_cancellation": {
        const args = tc.arguments ?? {};
        const itemName =
          typeof args.item_name === "string" ? args.item_name.trim() : "";
        const reason =
          typeof args.reason === "string" ? args.reason.trim() : "";
        if (!itemName) return { name };
        const result = await requestItemCancellationByName({
          tableId: tableKey,
          itemName,
          reason,
        });
        if (result.error) {
          console.warn(
            "[api/chat] request_item_cancellation failed:",
            result.error.message ?? result.error
          );
        } else {
          console.log("[api/chat] AI request_item_cancellation ->", result);
        }
        return { name, result };
      }

      case "submit_order": {
        // The cart is client-authoritative (see createOrderFromCart doc
        // comment below) — the client sends it on every /api/chat call.
        if (clientCart.length === 0) {
          return {
            name,
            orderError: {
              status: 400,
              message: "submit_order was requested but no cart was provided",
            },
          };
        }
        const result = await createOrderFromCart({
          table_id: tableKey,
          items: clientCart,
        });
        if (result.error) return { name, orderError: result.error };
        return { name, createdOrder: result.order };
      }

      default:
        // update_cart / request_check / anything else: purely client-side,
        // nothing to dispatch server-side.
        return { name };
    }
  } catch (err) {
    console.error(
      `[api/chat] tool call "${name}" threw:`,
      err?.message ?? err
    );
    return { name, error: err };
  }
}

app.post("/api/chat", async (req, res) => {
  const __t0 = Date.now(); // [CHAT_TIMING]
  try {
    const { messages, table } = req.body ?? {};

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        error: "JSON body must include an array field `messages` (chat history).",
      });
    }

    const tableKey =
      typeof table === "string" && table.trim() !== "" ? table.trim() : "T?";

    // Cap how much prior chat gets replayed to Groq on every turn. Order
    // state and cart are re-fetched fresh each request (see
    // ORDER STATE IS AUTHORITATIVE in SYSTEM_PROMPT) and don't depend on
    // this history, so trimming old turns is safe — it just bounds the
    // prompt token count (and therefore Groq latency/TPM headroom) from
    // growing unbounded over a long session instead of staying roughly flat.
    // Lowered from 24 -> 16: the static system prompt + tool schemas already
    // consume the large majority of this account's 8000 TPM cap on their
    // own, so history is a secondary lever here, not the primary fix — but
    // every turn of headroom matters. 16 messages (~8 exchanges) still
    // covers a full single-item 6-step order flow; MEMORY RULE's "track the
    // cart from what you've SAID" still has the cart injection below as a
    // structured backstop even if a much longer conversation ages a turn out.
    const MAX_HISTORY_MESSAGES = 16;
    const history = messages
      .filter((m) => m && typeof m === "object")
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content == null
              ? ""
              : JSON.stringify(m.content),
      }));

    // These three reads are fully independent of one another (menu catalog,
    // runner-service options, and this table's live order) — fetch them
    // concurrently instead of sequentially so total wait time is the slowest
    // single call, not the sum of all three. This is on the hot path of
    // every chat turn, so shaving redundant round-trips matters directly for
    // Groq-speed latency.
    const [
      { data: menuRows, error: menuError },
      runnerOptions,
      { items: currentOrderItems, error: orderStateError },
    ] = await Promise.all([
      fetchMenuItemsWithRetry(),
      fetchRunnerOptions(),
      // Fetched fresh on every single turn — deliberately NOT derived from
      // `history`/`messages`, which resets whenever the guest starts a new
      // chat session (e.g. reopening the app). The order itself lives in
      // Postgres regardless of chat session, so this is the only reliable
      // way for the AI to know what's actually been ordered.
      fetchActiveTableOrderItems(tableKey),
    ]);
    const __t1 = Date.now(); // [CHAT_TIMING]

    if (menuError) {
      console.error("[api/chat] Supabase menu_items error:", menuError);
      return res.status(503).json({
        code: "menu_unavailable",
        error:
          "Could not load the menu (database connection dropped). Please try again in a few seconds.",
      });
    }

    if (orderStateError) {
      console.warn(
        "[api/chat] fetchActiveTableOrderItems error:",
        orderStateError
      );
    }
    const orderStateText = formatOrderStateForPrompt(currentOrderItems);

    // Sent by the client on every turn (see chatApi.ts) — the guest's
    // in-progress, not-yet-submitted cart. Read here (not just at
    // submit_order time) so the model has real ground truth instead of
    // having to infer cart contents from its own past sentences.
    const clientCart = Array.isArray(req.body?.cart) ? req.body.cart : [];
    const cartStateText = formatCartForPrompt(clientCart, menuRows);
    const cartIsNonEmpty =
      cartStateText !== "Nothing has been added to the cart yet this session.";

    // Used below by both the duplicate-add guard and the STEP 5 finalization
    // backstop — resolved once here from the raw (untrimmed) `messages`
    // array so both checks see the guest's actual latest wording, not just
    // the capped `history` slice.
    const latestUserMessage = [...messages]
      .reverse()
      .find((m) => m && typeof m === "object" && m.role === "user");
    const latestUserText =
      typeof latestUserMessage?.content === "string" ? latestUserMessage.content : "";
    const latestUserLang = /[\u0590-\u05FF]/.test(latestUserText) ? "he" : "en";

    const compactMenu = formatMenuForPrompt(menuRows);

    // Structured, server-tracked ground truth for what's already been sent
    // to the Runner dashboard this session — mirrors how the cart/order
    // sections work below. Without this, the model has to recall from raw
    // conversation prose whether it already called 'request_runner', which
    // is exactly what caused it to re-call the tool (and re-narrate "on the
    // way") on later, unrelated turns.
    const tableRunnerAlerts = activeRunnerAlerts.filter((a) => a.table === tableKey);
    const runnerAlertsText =
      tableRunnerAlerts.length > 0
        ? tableRunnerAlerts.map((a) => `- ${a.request}`).join("\n")
        : "Nothing sent yet.";

    const systemContent = `${SYSTEM_PROMPT}

The following table service items are currently available: ${runnerOptions}. If the guest asks for a runner/table-service item that is NOT in this list, apologise and tell them it is not available — never silently substitute or invent.

--- Menu ---
${compactMenu}

--- Your current cart (already added via update_cart this session — NOT yet sent to the kitchen) ---
${cartStateText}
This is the DEFINITIVE record of what's already in the cart. NEVER call 'update_cart' again for an item listed here — if the guest just accepted a suggestion (a side, a drink, a dessert), call 'update_cart' for THAT newly-accepted item, which will NOT be listed here yet, not for anything already shown above.
NEVER RE-LITIGATE A RESOLVED STEP (CRITICAL): The conversation history above is just as authoritative as this list for what you've already SAID and already asked. If you already told the guest "I've added <item>" or already made a suggestion earlier in this conversation, do not say it again or re-ask it — even if this cart list looks incomplete or empty, that is a display lag, not permission to restart the order. Always reply as a continuation of the conversation so far, picking up exactly where the last message left off (e.g. moving on to the next step, or answering their latest message) — never repeat an earlier reply verbatim or re-introduce an item you already confirmed. If the guest's latest message doesn't add anything new (e.g. a plain "no"/"good"/"that's it") and the cart above is non-empty, that message is very likely the finalization signal from STEP 5/NO REPEATED CONFIRMATIONS — call 'submit_order' now instead of producing another "Added <item>" or "anything else?" reply.

--- Runner requests already sent to the Runner dashboard for this table this session (DEFINITIVE — fetched fresh, not your memory) ---
${runnerAlertsText}
NEVER call 'request_runner' again for anything already listed here — it is already dispatched, calling it again sends a duplicate real notification to kitchen staff. NEVER keep repeating "on the way"/"napkins are coming" confirmations for these in later replies either — say it ONCE when you first dispatch it, then move the conversation forward (e.g. "anything else?") instead of re-stating already-handled items.

--- Already ordered for this table (fetched fresh just now — this is the CURRENT, AUTHORITATIVE record; it is NOT the same thing as what you remember from earlier in this conversation, and it stays accurate even if this is a brand-new chat session) ---
${orderStateText}`;

    const chatTools = buildGroqChatTools(runnerOptions);

    const apiMessages = [
      { role: "system", content: systemContent },
      ...history,
      { role: "system", content: PERSONA_ANCHOR_SYSTEM_MESSAGE },
    ];
    const __t2 = Date.now(); // [CHAT_TIMING]
    const __promptChars = apiMessages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0
    );
    // [CHAT_TIMING] per-component breakdown, for diagnosing prompt-size /
    // TPM issues without re-instrumenting from scratch.
    const __toolsChars = CHAT_TIMING ? JSON.stringify(chatTools).length : 0;
    const __historyChars = CHAT_TIMING
      ? history.reduce((s, m) => s + (m.content?.length ?? 0), 0)
      : 0;

    const completion = await createGroqChatCompletionWithTools({
      model: GROQ_CHAT_MODEL,
      messages: apiMessages,
      tools: chatTools,
    });
    const __t3 = Date.now(); // [CHAT_TIMING]
    if (CHAT_TIMING && completion.usage) {
      console.log(
        `[chat-timing:usage] model=${GROQ_CHAT_MODEL} real_prompt_tokens=${completion.usage.prompt_tokens} real_completion_tokens=${completion.usage.completion_tokens} real_total_tokens=${completion.usage.total_tokens}`
      );
    }
    chatTimingLog({
      breakdown: "chars",
      system_prompt_static: SYSTEM_PROMPT.length,
      menu: compactMenu.length,
      cart: cartStateText.length,
      order_state: orderStateText.length,
      history: __historyChars,
      history_msg_count: history.length,
      persona_anchor: PERSONA_ANCHOR_SYSTEM_MESSAGE.length,
      tools_json: __toolsChars,
      total_message_chars: __promptChars,
    });

    const choice = completion.choices?.[0];
    const msg = choice?.message;
    let text =
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

    // DUPLICATE ADD-CONFIRMATION GUARD: despite MEMORY RULE / NEVER
    // RE-LITIGATE / NO REPEATED CONFIRMATIONS in the prompt above, this
    // model has been observed re-calling 'update_cart' for an item that's
    // already in the client's cart at the exact same quantity — a
    // functional no-op (the client applies update_cart as an absolute "set
    // total to", see setGuestCartLine in frontend/src/simulator/
    // simulatorStore.ts, so this never actually double-charges the guest),
    // but it still re-narrates "Added <item> to your order" verbatim, which
    // reads to the guest as if something is being re-added and stalls the
    // conversation instead of moving to the next step. Detected here against
    // the client's authoritative cart (not the model's own past prose) and
    // rewritten into a forward-moving nudge — we rewrite rather than drop
    // the tool call so a turn where this was the model's ONLY tool call
    // still has a visible reply instead of falling through to the client's
    // generic "I didn't quite catch that" fallback.
    const existingCartLineByMenuId = new Map(
      clientCart
        .filter((l) => typeof l?.menu_item_id === "string")
        .map((l) => [
          l.menu_item_id,
          {
            quantity: Number(l?.quantity ?? 0),
            notes: typeof l?.notes === "string" ? l.notes.trim() : "",
          },
        ])
    );
    for (const tc of tool_calls) {
      if (tc.name !== "update_cart") continue;
      const args = tc.arguments ?? {};
      const itemName = typeof args.item_name === "string" ? args.item_name : "";
      const qty = Number(args.quantity);
      if (!itemName || !Number.isFinite(qty) || qty <= 0) continue;
      const menuId = resolveMenuItemIdByName(menuRows, itemName);
      if (!menuId) continue;
      const existing = existingCartLineByMenuId.get(menuId);
      if (!existing || existing.quantity !== qty) continue;
      // Also require special_requests to be unchanged — same quantity but a
      // new/changed modifier (e.g. "no tomato" added after the fact) is a
      // real update, not a no-op re-confirmation. No special_requests field
      // at all means "keep whatever notes are already there" (matches
      // setGuestCartLine in simulatorStore.ts), so that case never counts
      // as a change.
      const requestedNotes =
        typeof args.special_requests === "string" ? args.special_requests.trim() : existing.notes;
      if (requestedNotes !== existing.notes) continue;
      console.log(
        `[api/chat] update_cart no-op duplicate suppressed for table ${tableKey}: "${itemName}" already at qty ${qty}`
      );
      tc.arguments = {
        ...args,
        guest_reply:
          latestUserLang === "he"
            ? "זה כבר בהזמנה שלכם — משהו נוסף, או שאשלח את ההזמנה למטבח?"
            : "That's already on your order — anything else, or shall I send this to the kitchen?",
      };
    }

    // Server-side tool dispatch. We still return the FULL tool_calls array
    // to the client so its `guest_reply`(s) can show in the chat bubble and
    // `update_cart`/`request_check` can run client-side, but any tool with a
    // server-side effect (runner alert, cancellation request, kitchen order
    // submission) is executed here, concurrently, over every entry in
    // `tool_calls` — never just the first one, and never sequentially in a
    // way where one call's outcome blocks another's. This is what makes a
    // single guest turn like "send the Salmon and Lemonade to the kitchen
    // and bring some ketchup" (submit_order + request_runner together)
    // actually dispatch both instead of silently dropping one.
    const toolResults = await Promise.all(
      tool_calls.map((tc) => executeChatToolCall(tc, { tableKey, clientCart }))
    );

    let createdOrder = null;
    let orderError = null;
    for (const r of toolResults) {
      if (r.name !== "submit_order") continue;
      if (r.orderError) orderError = r.orderError;
      if (r.createdOrder) createdOrder = r.createdOrder;
    }

    // RUNNER REQUEST FINALIZATION BACKSTOP: independent of the STEP 5 cart
    // backstop below — a runner request (napkins, etc.) is its own thread
    // (see "COMPLETELY SEPARATE thread" in RUNNER REQUESTS / STEP 5 above)
    // and must never depend on food-order state to get dispatched. Live
    // testing showed the model reliably narrates a runner item in plain
    // text on first mention ("I've noted napkins for you" — correct, RUNNER
    // REQUESTS step 1 says no tool yet there) but then frequently never
    // actually calls 'request_runner' once the guest gives a "no more"
    // signal or the order gets finalized, even though RUNNER REQUESTS step 3
    // and STEP 5's "re-scan entire conversation" instruction both explicitly
    // require it — same class of bug as the STEP 5 backstop, just for the
    // other tool, and just as invisible to the guest (the AI's own text
    // claimed it was "noted", so nothing looks wrong until a runner never
    // shows up table-side).
    //
    // Deliberately run as a function called at TWO points rather than once:
    // first BEFORE the STEP 5 cart backstop below (trigger: the guest's
    // latest message is itself a decline/done signal), so that if it fires,
    // the STEP 5 backstop's own "did request_runner fire this turn" WEAK-
    // signal corroboration check (see below) sees it and can use it —
    // running this only *after* STEP 5 would make that corroboration signal
    // permanently unavailable whenever it's this backstop (rather than the
    // model) doing the dispatching, which live testing confirmed silently
    // stops the food order itself from ever finalizing on a bare "no". It's
    // called again AFTER STEP 5 (trigger: 'submit_order' ended up firing
    // this turn) to also catch an explicit send instruction that isn't
    // itself a decline phrase (e.g. "please send my order now"). The
    // function is idempotent — it no-ops immediately if 'request_runner'
    // already fired this turn — so calling it twice is safe.
    //
    // Scans the FULL conversation (not just the capped `history` sent to
    // Groq) for a mention of a known runner item (from the live "table
    // service items" list) that isn't already in "--- Runner requests
    // already sent ---". A mention that also resolves to a real menu item
    // already in the cart (e.g. "Sparkling Water" the drink vs a generic
    // "Water" runner option) is excluded — that's a food order, not a
    // table-service request.
    //
    // Unlike the STEP 5 cart backstop, this doesn't wait for a "strong"
    // signal or a second corroborating decline: a false-positive early
    // dispatch just means staff bring napkins a beat sooner (harmless, and
    // `executeChatToolCall`'s duplicate-alert guard still applies), whereas
    // the observed failure mode is the request never reaching the Runner
    // dashboard at all.
    async function maybeForceRunnerDispatch(trigger) {
      if (!trigger) return;
      if (tool_calls.some((t) => t.name === "request_runner")) return;
      const knownRunnerItems = (runnerOptions || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const allUserText = messages
        .filter((m) => m && typeof m === "object" && m.role === "user" && typeof m.content === "string")
        .map((m) => m.content)
        .join(" \n ")
        .toLowerCase();
      const undispatched = knownRunnerItems.filter((opt) => {
        const needle = opt.toLowerCase();
        if (!allUserText.includes(needle)) return false;
        const menuId = resolveMenuItemIdByName(menuRows, opt);
        if (menuId && clientCart.some((l) => l.menu_item_id === menuId)) return false;
        const alreadyDispatched = tableRunnerAlerts.some((a) =>
          a.request.toLowerCase().includes(needle)
        );
        return !alreadyDispatched;
      });
      if (undispatched.length === 0) return;

      const request = undispatched.join(", ");
      const runnerResult = await executeChatToolCall(
        { name: "request_runner", arguments: { request } },
        { tableKey, clientCart }
      );
      if (runnerResult.alert) {
        tool_calls.push({
          id: `forced_runner_${Date.now()}`,
          name: "request_runner",
          arguments: {
            request,
            guest_reply: buildForcedRunnerGuestReply(undispatched, latestUserLang),
          },
        });
        console.log(
          `[api/chat] RUNNER finalization backstop: model omitted request_runner, forced it for table ${tableKey}: "${request}"`
        );
      }
    }
    await maybeForceRunnerDispatch(isDeclineFurtherItemsPhrase(latestUserText));

    // STEP 5 FINALIZATION BACKSTOP: the model is instructed (STEP 5 /
    // NO REPEATED CONFIRMATIONS / MULTIPLE TOOLS IN ONE TURN above) to call
    // 'submit_order' the moment the guest declines further items with a
    // non-empty cart, but live testing showed it doesn't reliably do so —
    // sometimes it just re-asks "anything else?" indefinitely, sometimes it
    // fires 'request_runner' alone (its own signal that it judged the guest
    // "done") and leaves the cart unsent. Either failure means the guest's
    // food never reaches the kitchen with no error shown to them at all —
    // worse than a premature submit, which at most sends real, already-
    // agreed-upon cart contents a turn early. So: if the model did NOT call
    // 'submit_order' this turn, the cart is genuinely non-empty, and the
    // guest's latest message is a decline ("no"/"that's all"/"that's it"/
    // etc, no new item) — finalize for real here: actually call
    // createOrderFromCart (never fabricate a "sent" claim), and only
    // synthesize a submit_order tool_call/guest_reply for the client to show
    // if that call genuinely succeeded. Once it succeeds, the client clears
    // its cart (see ChatScreen.tsx), so `cartIsNonEmpty` is false on every
    // later turn — this can't re-fire for the same order.
    //
    // How much corroboration is required depends on how explicit the
    // decline is (see isStrongDoneSignal doc comment): a STRONG "I'm
    // completely done" phrase ("that's it"/"nothing else"/"all set"/etc) is
    // unambiguous on its own, even the very first time it's said and even
    // when it's answering a specific upsell offer (e.g. declining a
    // suggested side with "No thanks, that's it") rather than a plain
    // "anything else?" — a runner request (e.g. napkins) being mentioned or
    // dispatched earlier/alongside is irrelevant to this and never
    // substitutes for it; food-order completion is judged purely from the
    // guest's own words. A WEAK bare "no"/"nope" alone is kept more
    // conservative and still requires a second signal (a prior decline
    // elsewhere in the conversation, or the model itself firing
    // 'request_runner' this turn) before forcing finalization — otherwise a
    // guest declining a side offer while the drink question hasn't even
    // been asked yet would get their order finalized prematurely.
    if (!createdOrder && !orderError && cartIsNonEmpty) {
      const submitOrderCalledThisTurn = tool_calls.some((t) => t.name === "submit_order");
      if (!submitOrderCalledThisTurn && isDeclineFurtherItemsPhrase(latestUserText)) {
        const strongDoneSignal = isStrongDoneSignal(latestUserText);
        const runnerCalledThisTurn = tool_calls.some((t) => t.name === "request_runner");
        const priorDeclineSeen = messages.some(
          (m) =>
            m &&
            typeof m === "object" &&
            m.role === "user" &&
            m !== latestUserMessage &&
            isDeclineFurtherItemsPhrase(typeof m.content === "string" ? m.content : "")
        );
        if (strongDoneSignal || runnerCalledThisTurn || priorDeclineSeen) {
          const forced = await createOrderFromCart({ table_id: tableKey, items: clientCart });
          if (forced.order) {
            createdOrder = forced.order;
            tool_calls.push({
              id: `forced_submit_${Date.now()}`,
              name: "submit_order",
              arguments: {
                guest_reply: buildForcedFinalizeGuestReply(clientCart, menuRows, latestUserLang),
              },
            });
            console.log(
              `[api/chat] STEP 5 finalization backstop: model omitted submit_order, forced it for table ${tableKey} (signal=${strongDoneSignal ? "strong" : runnerCalledThisTurn ? "runner" : "prior-decline"})`
            );
          } else if (forced.error) {
            // Don't surface this as `orderError` here — no submit_order
            // tool_call is being added to `tool_calls` on this failure path,
            // so the client's `hadSubmitOrder` check stays false and it
            // won't show a "there was an error sending your order" message
            // it never actually promised. Just log for observability; the
            // model gets another chance to call 'submit_order' itself (or
            // this backstop retries) on the guest's next message.
            console.warn(
              "[api/chat] STEP 5 finalization backstop attempted submit_order but it failed:",
              forced.error
            );
          }
        }
      }
    }

    // Second call point for the runner backstop defined above — catches an
    // explicit send instruction that isn't itself a decline phrase (e.g.
    // "please send my order now") but did result in 'submit_order' firing
    // this turn (organically or via the STEP 5 backstop just above). A
    // no-op if the first call point already dispatched it.
    await maybeForceRunnerDispatch(tool_calls.some((t) => t.name === "submit_order"));

    // EMPTY TURN BACKSTOP: a rare Groq failure mode where the model returns
    // neither usable text nor a real tool call — either the whole completion
    // is empty (no content, no tool_calls), or it calls 'update_cart' with a
    // blank item_name AND a blank guest_reply, which is a pure no-op (a real
    // removal call always has a real item_name; only this garbage shape has
    // both fields blank) that would otherwise leave the guest staring at an
    // empty chat bubble. Live-measured at roughly 7% specifically on a food
    // item carrying an "ask:" modifier combined with a runner request in the
    // same message (e.g. "burger and extra napkins", where STEP 1 says not
    // to call 'update_cart' yet, so the correct turn is plain text with no
    // tool call at all — that's the shape this Groq/model quirk seems to hit
    // most). Strip any such vacuous call, and if nothing meaningful is left
    // this turn, substitute a generic "didn't catch that" prompt in the
    // guest's language rather than showing them nothing at all.
    for (let i = tool_calls.length - 1; i >= 0; i--) {
      const tc = tool_calls[i];
      if (
        tc.name === "update_cart" &&
        !(tc.arguments?.item_name ?? "").toString().trim() &&
        !(tc.arguments?.guest_reply ?? "").toString().trim()
      ) {
        tool_calls.splice(i, 1);
      }
    }
    if (tool_calls.length === 0 && (!text || !text.trim())) {
      text =
        latestUserLang === "he"
          ? "סליחה, לא הבנתי לגמרי. תוכלו לומר את זה שוב?"
          : "Sorry, I didn't quite catch that — could you say it again?";
      console.log(
        `[api/chat] EMPTY TURN backstop: model returned no usable content for table ${tableKey}, substituted fallback reply`
      );
    }

    const __t4 = Date.now(); // [CHAT_TIMING]

    chatTimingLog({
      table: tableKey,
      model: GROQ_CHAT_MODEL,
      total_ms: __t4 - __t0,
      context_fetch_ms: __t1 - __t0,
      prompt_build_ms: __t2 - __t1,
      groq_call_ms: __t3 - __t2,
      tool_exec_ms: __t4 - __t3,
      prompt_chars: __promptChars,
      prompt_chars_est_tokens: Math.round(__promptChars / 4),
      history_messages: history.length,
      tool_calls: tool_calls.map((t) => t.name).join(",") || "none",
    });

    const hasClientTools = tool_calls.some(
      (t) =>
        t.name === "update_cart" ||
        t.name === "submit_order" ||
        t.name === "request_runner" ||
        t.name === "request_check" ||
        t.name === "request_item_cancellation"
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
    if (isGroqToolUseFailedError(err)) {
      console.error("[api/chat] Groq tool_use_failed after retry:", err?.message ?? err);
      return res.status(502).json({
        code: "tool_use_failed",
        error:
          "The waiter could not update your order due to a tool-format error. Please try sending your message again.",
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
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
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
