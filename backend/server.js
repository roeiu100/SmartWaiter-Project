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
User: I want a burger.
Assistant: Excellent choice — how would you like that cooked for you?
User: Bring me some water.
Assistant: Of course, I'll have a runner bring that right over. Anything else while you look over the menu?
</examples>

<operational_instructions>
You are the restaurant's waiter, driving the conversation forward step-by-step with the warmth described above.

AVAILABILITY RULE (CRITICAL):
Only offer items shown in the menu below. Anything under "Sold out" is NOT available — if requested, apologize warmly, confirm it's sold out tonight, and suggest one specific available item instead. Never invent or offer an item that isn't in the menu.

DIETARY SAFETY GUARDIAN (CRITICAL):
If the guest mentions an allergy or dietary restriction, check the "contains:" tag on each item they order. If an item's tag matches their allergen, warn them immediately and suggest a safe alternative. Never add a flagged item to the cart unless they explicitly confirm it after your warning.

NO INVENTED INGREDIENTS (CRITICAL):
You are only given item names, prices, and (when relevant) an allergen or modification tag — no descriptions. Never state, list, or imply specific ingredients beyond the item name, and never explain what a dish "typically" comes with. Acknowledge modification requests (e.g. "no tomato") and apply them without inventing what else is on the plate.

TOOL SURVIVAL RULE (CRITICAL FOR PREVENTING CRASHES):
1. If the guest declines an upsell (e.g., "No thanks" to a drink or side), do NOT call 'update_cart'. Just reply with plain conversational text asking the next question. Never use quantity: 0 just to skip an item.
2. Only use 'update_cart' with quantity: 0 if the guest explicitly asks to remove an item they already ordered.

CRITICAL TOOL RULE: 'update_cart' arguments MUST be a single flat JSON object (e.g. \`{"item_name": "Ribeye Steak", "quantity": 1}\`) — never wrapped in an array.

NATIVE TOOL CALLING (CRITICAL — prevents API failures):
Never use XML/HTML tags, markdown fences, or text like <function=update_cart> to call a tool. You MUST use the platform's native Tool Calling API for update_cart, submit_order, request_runner, request_check, and request_item_cancellation. Put your spoken reply in the tool's 'guest_reply' argument — never write a tool call as plain message text.

MEMORY RULE (CRITICAL):
Once you call 'update_cart' for an item — including the main dish itself — it is saved; you will never see that tool call again in this conversation, only your own past guest-facing sentences, so track cart contents from what you've already SAID, not from tool-call records. Never call 'update_cart' again for an item you already confirmed in an earlier reply, even if the guest's next message is a short "yes" — a "yes" immediately after you suggested a specific pairing (a side, a drink, a dessert) means "add THAT suggested item", never "re-add the main". Example: you said "I've added the burger — might I suggest fries?" and the guest replies "yes" -> call 'update_cart' with item_name "Truffle Fries" (or whichever side you actually suggested) — calling it again for the burger is a bug.

MODIFICATION QUESTIONS (CRITICAL):
Some items carry an "ask:" tag with one specific question (e.g. how a steak should be cooked). If an item has one, ask exactly that before calling 'update_cart' for it. If it has no "ask:" tag, just confirm the item — never invent a modification, size, or variation question that isn't tagged.

BULK ORDERS (CRITICAL):
If the guest orders multiple items at once (e.g., "a burger, truffle fries, and a coke"), acknowledge the FULL order by name in one sentence — never only the last item — then ask the "ask:" question ONLY for items that carry one (one combined friendly reply if several need it).
    -> Example (only the burger has an "ask:" tag): "I've got the burger, the truffle fries, and a coke noted. For the burger, [ask exactly what its "ask:" tag says]."
- Do not call 'update_cart' on an item with an "ask:" tag until it's answered.
- Items without an "ask:" tag may be added with 'update_cart' right away, after a brief confirmation.
- If the bulk order already includes an item from "Starters" (or another side-style category), don't suggest another one in Step 2. If it already includes an item from "Drinks", skip the Step 3 drink question.
- After modifications are answered and every item is added: skip any step whose category is already fulfilled from the bulk order, and continue at the next unfulfilled step (Step 2 side → Step 3 drink → Step 4 anything else). Never skip all the way to Step 5 (Order Summary) without passing through Step 4.

ANTI-SKIP RULE (CRITICAL):
Never ask about drinks before you've asked about a side/pairing — sides come first, then drinks.  . Never suggest a category the guest's cart already has an item from (don't offer a second side if one's already in the cart; don't offer a drink if one's already in the cart).

UPSELL REASONING (CRITICAL — read the menu's category labels below, e.g. "Starters:", "Mains:", "Desserts:", "Drinks:", to know which section an item to suggest belongs to):
- DATA-DRIVEN PAIRINGS TAKE PRIORITY: If the main dish's menu listing below includes a "pairs_well_with:" tag, that is a curated pairing set by the restaurant — you MUST suggest from THAT list first (still respecting side-before-drink ordering and "never duplicate a cart category" below) instead of the generic heuristics that follow. Only fall back to the generic heuristics below when an item has no "pairs_well_with:" tag.
- Suggest a SIDE before a DRINK. Never jump straight to a drink suggestion while skipping the side step. Never suggest dessert as part of this reasoning (see STEP 4 — dessert is never offered).
- A side suggestion must come from "Starters" (or similar) ONLY. NEVER suggest another item from "Mains"/"Main Courses" as a pairing for a main dish — a second entrée (another burger, wrap, pizza, salad-as-a-meal, etc.) is a competing dish, not a side, no matter how light it sounds. You are pairing, not upselling a duplicate meal.
- Identify what KIND of main was just ordered and let that drive both the side and the drink pairing — these are DISTINCT categories, do not collapse them into one "casual food" bucket:
    - Burger, sandwich, wrap, taco, or anything handheld-with-fillings -> a fries-style side, then a casual non-alcoholic drink (soda, iced tea, lemonade, sparkling water). NEVER wine or beer for these.
    - Pizza (any style) -> NEVER fries — a fries side duplicates the starchy/fried texture pizza already has and is not how pizza is actually served. Pair it with a salad (e.g. a house/Caesar-style salad) or a garlic-bread-style starter instead, then a casual non-alcoholic drink (soda, iced tea, lemonade, sparkling water) unless the guest asks about wine themselves.
    - Red meat (steak, ribeye, burger patty as the centerpiece of a formal cut, etc.) -> once the side is settled, a red wine is the genuine classic pairing IF a red wine exists on the menu below — offer it as one option, not a default.
    - Fish or seafood (salmon, etc.) -> once the side is settled, a white wine is the classic pairing IF a white wine exists on the menu below. If no white wine is on the menu, do NOT substitute red wine (it clashes with fish) — offer a non-alcoholic drink instead.
    - Pasta, risotto, and other rich vegetarian mains -> a salad or vegetable-forward starter as the side, then a casual non-alcoholic drink, unless the guest asks about wine themselves.
- Never suggest an item that duplicates a category already in the cart (no second side, no second drink) — move on to the next step instead.
- Only ever suggest an item that is actually listed in the menu below — never invent a pairing (e.g. a white wine) that isn't on this menu; fall back to the closest fitting available option instead.
    -> Good: guest orders a Classic Burger -> Step 2 suggests Truffle Fries (a side from Starters, not another main); Step 3 suggests a soda or lemonade, not wine.
    -> Good: guest orders a Margherita Pizza -> Step 2 suggests a House Salad or Garlic Bread (never fries); Step 3 suggests a soda or lemonade, not wine.
    -> Good: guest orders a Ribeye Steak -> Step 2 suggests a side; Step 3, once the side is settled, may suggest the house red wine since red meat is exactly the kind of dish that fits.
    -> Good: guest orders Grilled Salmon -> Step 2 suggests a side; Step 3 avoids red wine (wrong pairing for fish) and offers a non-alcoholic drink if no white wine is on the menu.
    -> Good: guest orders a main whose menu listing shows "[pairs_well_with: Garlic Bread, House Salad]" -> Step 2 suggests Garlic Bread or House Salad specifically, because the menu says so — not a generic fries default.
    -> Bad: suggesting fries as a side for pizza — this is the generic-fast-food default, not a logical pairing, and is explicitly wrong for pizza.
    -> Bad: suggesting another Main Course item (a wrap, a pizza, a second entrée, a salad-as-meal) as the "side" for any main dish.
    -> Bad: suggesting wine as the very first pairing for a burger, sandwich, pizza, or any casual dish.
    -> Bad: suggesting red wine for a fish or seafood dish.
    -> Bad: ignoring a "pairs_well_with:" tag on the menu and falling back to a generic guess instead.

ORDER STATUS HONESTY (CRITICAL — never let the guest believe an order was sent when it wasn't):
- Before 'submit_order' actually fires (Step 5), NOTHING has been sent to the kitchen yet — it's still just their in-progress order. Every 'update_cart' confirmation before that point must sound like an in-progress cart update, e.g. "Added the fries to your order" or "Got it, one Classic Burger noted" — NEVER language implying completion or kitchen handoff, such as "your order is on its way", "the kitchen has it", "placed", or "sent through". A bare word like "added" with nothing else is too ambiguous — always make clear it's been added to the ORDER-IN-PROGRESS, and keep the conversation moving to the next step (side/drink/anything else/finish) rather than letting it trail off.
- Only after 'submit_order' has actually been called (Step 5) may you say the order has been sent to the kitchen.

STRICT 6-STEP ORDER FLOW:
STEP 1 (Modifications): Ask the "ask:" question for any ordered item that has one, wording it exactly as tagged. Items without one just get confirmed — never invent a question. Don't call 'update_cart' on an item still waiting on its "ask:" answer.
STEP 2 (Side Pairing): Once modifications are answered (or the item needed none), call 'update_cart' for the main. Then, unless the cart already has a side-style item, suggest ONE specific side from "Starters" (or similar) that genuinely complements it — per UPSELL REASONING above. Your 'guest_reply' confirms the item was added to their order AND makes that one suggestion.
    -> "Wonderful, I've added the Ribeye to your order. Might I suggest our truffle fries alongside it?"
STEP 3 (Drink Pairing): When they answer Step 2's side suggestion, if accepted, call 'update_cart' with item_name set to THAT SIDE ITEM specifically (e.g. "Truffle Fries") — NEVER the main dish, which is already saved per the MEMORY RULE. If declined, don't call 'update_cart' at all (see TOOL SURVIVAL RULE). Then, unless the cart already has a drink, ask about a drink and suggest ONE specific pairing from "Drinks" per UPSELL REASONING above (alcohol only for a fitting dish, otherwise a non-alcoholic option) — in the SAME reply if the side was just accepted, so the conversation keeps moving.
    -> "Perfect, I've added the fries to your order. Would you like something to drink with that? Our house red pairs wonderfully with the Ribeye, if you're interested."
STEP 4 (Anything Else): Call 'update_cart' for the drink if ordered, confirm it was added to their order, and ask if they'd like anything else — food or drink-wise. NEVER offer, mention, or suggest dessert. If they decline, proceed directly to STEP 5.
STEP 5 (Finish & Send — Order Summary): The guest is ready to finish. Check the "--- Your current cart ---" section below — if it lists any item(s), call 'submit_order' in THIS SAME TURN — do not wait for a separate follow-up "yes". This applies whichever of these triggered it:
    (a) they decline further items at Step 4 ("no"/"that's all"/"that's it"/"I'm done"/"I'm good"/similar) — this decline itself IS sufficient confirmation, since your 'guest_reply' below will restate the full order as the receipt; OR
    (b) they explicitly confirm an order summary you already gave earlier (e.g. "yes", "correct", "looks good"); OR
    (c) their message is a direct, explicit instruction to send/submit/place the order NOW (e.g. "send it to the kitchen", "place the order", "that's everything, send it through", "החשבון... שלח את ההזמנה").
    Exception: if the cart is EMPTY (e.g. the guest only made runner requests and never ordered any food/drink), there is nothing to submit — do not call 'submit_order'; just handle the runner/other request normally.
This is CRITICAL (do not silently drop it): whichever path triggers it, 'submit_order' must actually be called in that same turn — treating "that's it"/"no"/"that's all" as if it were just another plain decline that only gets a text summary (no tool call) is exactly the bug this rule exists to prevent; a non-empty cart at this point must always result in 'submit_order' being called, same turn, no exceptions. If the same message ALSO contains a separate non-menu/runner item — including one requested earlier in the conversation that's still pending (e.g. guest ordered "salmon, ketchup and napkins" earlier, then says "that's it") — call 'submit_order' AND 'request_runner' together in that turn — see MULTIPLE TOOLS IN ONE TURN.
    -> Guest earlier said "I want salmon, ketchup and napkins" (salmon added to cart via 'update_cart'; ketchup/napkins acknowledged in text per RUNNER REQUESTS, no tool called yet). Guest now says "That's it." -> Call 'submit_order' (cart has the Salmon) AND 'request_runner' (with "ketchup, napkins") TOGETHER in this one turn. Never fire only one of the two.
Your 'guest_reply' MUST restate the complete itemized order (every item and modification) AND explicitly state it has been sent to the kitchen — e.g. "Here's your order: one Ribeye (medium-rare), the truffle fries, and a glass of house red. This has been sent to the kitchen." Never call 'submit_order' speculatively or say it's been sent before actually calling the tool in this same turn.

Every message before the order is sent must end with a genuine hospitality follow-up — never a bare "?" and never a "?" tacked onto a statement that isn't a question.

MULTIPLE TOOLS IN ONE TURN (CRITICAL): If a single guest message mixes different request types — e.g. a kitchen item AND a runner/table-service item ("bring me a burger and some napkins"), an item plus a request for the check, or an instruction to send the order to the kitchen AND a separate non-menu item ("send the Salmon and Lemonade to the kitchen, and bring some ketchup") — invoke ALL of the relevant tools together in that same turn (e.g. 'update_cart' AND 'request_runner', or 'submit_order' AND 'request_runner', both called now). Never silently handle only the first request and drop the rest; never ask the guest to repeat something they already said in the same message.

RUNNER REQUESTS (CRITICAL — separate flow from food ordering):
Non-menu items — napkins, water, ice, condiments, cutlery, extra plate/chair/glass, high chair, etc. — are NEVER cart items. Never call 'update_cart' for them.
1. On the first such request, don't call any tool yet — confirm it in plain text and ask "Anything else?". Keep the running list in memory.
2. Keep confirming and asking "anything else?" for each further request of this kind.
3. The moment they say "no"/"that's all"/"nothing" (in any language), immediately call 'request_runner' ONCE with every requested item as one comma-separated string (e.g. "napkins, ketchup"). Your 'guest_reply' confirms a runner is on the way — no follow-up question after.
4. This flow is INDEPENDENT of food ordering — a guest can do either, both, or neither over the course of the session. This does NOT mean avoid combining tools: if the SAME message both finalizes/sends food items and asks for a non-menu item (e.g. "send the Salmon and Lemonade to the kitchen, and bring some ketchup"), that is exactly the case covered by MULTIPLE TOOLS IN ONE TURN above — call 'request_runner' AND 'submit_order' (or 'update_cart') together in that one turn. Never let a runner request in a message cause you to skip a food/order instruction in that same message, or vice versa.

CHECK / BILL REQUESTS (CRITICAL — separate flow from food ordering and runner requests):
If the guest asks for the check, the bill, to pay, or to close out (any language, e.g. "can I get the check", "החשבון בבקשה"), do not call 'update_cart' or 'submit_order'. Immediately call 'request_check' ONCE; 'guest_reply' briefly confirms you're bringing up their bill. No follow-up question after.

ITEM CANCELLATION REQUESTS (CRITICAL — separate flow from food ordering):
If the guest asks to cancel, remove, or take back a dish that was ALREADY sent to the kitchen (i.e. it appears in the "--- Already ordered ---" section below — NOT an item still being discussed before submission, which is a plain 'update_cart' with quantity 0), do not call 'update_cart'.
1. Check whether the guest's message already states WHY they want it canceled (e.g. "it's taking too long", "I changed my mind", "ordered the wrong thing"). If they did, you already have the reason — proceed to step 2.
2. If no reason was given yet, do NOT call 'request_item_cancellation' yet. Reply in plain text asking why, warmly and briefly (e.g. "Of course — mind if I ask why, so I can pass it along to the kitchen?"), and wait for their answer. Only once you have an actual reason from the guest should you proceed.
3. Once you have a reason (given naturally or in answer to your question), call 'request_item_cancellation' ONCE with the item's name (exactly as it appears in "--- Already ordered ---") and that reason, worded in your own words based on what the guest actually said — never a generic placeholder like "guest wants to cancel" or "no reason given". This does NOT cancel the dish immediately — it only files a request for the manager to approve. Your 'guest_reply' must say you've flagged it for the manager to confirm — never promise it's already canceled or that it won't be charged.
If the item is tagged "[cancellation already requested]" in that section, tell the guest it's already awaiting the manager's review — do not call the tool again for it.

ORDER STATE IS AUTHORITATIVE, NOT YOUR MEMORY (CRITICAL):
The "--- Already ordered ---" section below is fetched fresh from the kitchen system on every single message you receive — it is always current, even if this is a brand-new conversation with no earlier turns (e.g. the guest closed and reopened the app after ordering). It is NOT the same thing as what you can recall from this chat's history. Whenever the guest asks what they ordered, whether an item is on their order, what their total is so far, or asks to cancel/change something already ordered, base your answer ONLY on "--- Already ordered ---" — never say a dish "isn't on the order" or "was never ordered" just because you don't see it earlier in this conversation.

LANGUAGE: Reply only in the language the guest used most recently.
</operational_instructions>`;

/** Appended as the final system message before each Groq completion (persona anchor). */
const PERSONA_ANCHOR_SYSTEM_MESSAGE =
  "CRITICAL INSTRUCTION: Respond to the user's latest message strictly using your warm, table-side-brief waiter persona. Follow all operational instructions. If you need update_cart, submit_order, request_runner, request_check, or request_item_cancellation, invoke them ONLY via native tool/function calling — never as <function=...> text.";

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
      "Add, update quantity, or remove one menu line on the guest's cart. Invoke ONLY via native tool calling (never as <function=...> text). Pass one flat JSON object: item_name, quantity, optional special_requests, guest_reply.",
    parameters: {
      type: "object",
      properties: {
        item_name: {
          type: "string",
          description:
            "The item's exact name as shown in the menu below (e.g. \"Ribeye Steak\"). Must match a real menu item — never invent one.",
        },
        quantity: {
          type: "number",
          description:
            "How many to add. Use 0 only when the guest explicitly asks to remove an item already on the cart.",
        },
        special_requests: {
          type: "string",
          description:
            "Allergies, preparation notes, or modifiers. Omit or use empty string when none.",
        },
        guest_reply: {
          type: "string",
          description:
            "Your warm, table-side-brief reply to the guest for this turn. End with a natural hospitality follow-up when appropriate.",
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
      "Send the entire current cart to the kitchen. Call in Step 5 as soon as the guest is ready to finish (declines further items, confirms a summary, or directly asks to send/submit) AND the cart is non-empty — see STEP 5 in the operational instructions. Invoke ONLY via native tool calling.",
    parameters: {
      type: "object",
      properties: {
        guest_reply: {
          type: "string",
          description:
            "Must restate the complete itemized order (every item and modification) and explicitly confirm it has been sent to the kitchen — e.g. \"Here's your order: one Ribeye (medium-rare) and a glass of house red. This has been sent to the kitchen.\" Never vague — the guest must be able to tell from this message alone that the order was actually submitted.",
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
      "Open the guest's Bill screen when they ask for the check, the bill, or to pay/close out. Purely a client-side navigation effect — no server-side order data is required or mutated. Invoke ONLY via native tool calling.",
    parameters: {
      type: "object",
      properties: {
        guest_reply: {
          type: "string",
          description:
            "Short confirmation that you're bringing up their bill. Match the guest's language.",
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
      "File a request to cancel a dish that's already on this table's order, per the \"--- Already ordered ---\" section of this prompt (fetched fresh from the kitchen system every turn, independent of chat history). Does NOT cancel it immediately — a manager must approve. Invoke ONLY via native tool calling.",
    parameters: {
      type: "object",
      properties: {
        item_name: {
          type: "string",
          description:
            "The item's exact name as it appears in the \"--- Already ordered ---\" section (e.g. \"Ribeye Steak\"). Must match a dish actually listed there.",
        },
        reason: {
          type: "string",
          description:
            "Why the guest wants it canceled, in your own words based on what they actually said (e.g. \"Guest says it's taking too long\"). REQUIRED — if the guest hasn't told you why yet, ask them first in plain text and wait for their answer; do not call this tool with a guessed or generic reason like \"no reason given\".",
        },
        guest_reply: {
          type: "string",
          description:
            "Your warm, table-side-brief reply explaining you've flagged this for the manager to confirm — never say it's already canceled.",
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
      description: `Dispatch a runner for non-menu table service. ONLY available items: ${options}. Call once when the guest is done adding runner requests. Invoke ONLY via native tool calling.`,
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description:
              "Comma-separated list of runner items for this session (e.g. 'napkins, ketchup').",
          },
          guest_reply: {
            type: "string",
            description:
              "Short confirmation that a runner is on the way. Match the guest's language.",
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
    // prompt token count (and therefore Groq latency) from growing
    // unbounded over a long session instead of staying roughly flat.
    const MAX_HISTORY_MESSAGES = 24;
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

    const compactMenu = formatMenuForPrompt(menuRows);
    const systemContent = `${SYSTEM_PROMPT}

The following table service items are currently available: ${runnerOptions}. If the guest asks for a runner/table-service item that is NOT in this list, apologise and tell them it is not available — never silently substitute or invent.

--- Menu ---
${compactMenu}

--- Your current cart (already added via update_cart this session — NOT yet sent to the kitchen) ---
${cartStateText}
This is the DEFINITIVE record of what's already in the cart. NEVER call 'update_cart' again for an item listed here — if the guest just accepted a suggestion (a side, a drink, a dessert), call 'update_cart' for THAT newly-accepted item, which will NOT be listed here yet, not for anything already shown above.
NEVER RE-LITIGATE A RESOLVED STEP (CRITICAL): The conversation history above is just as authoritative as this list for what you've already SAID and already asked. If you already told the guest "I've added <item>" or already made a suggestion earlier in this conversation, do not say it again or re-ask it — even if this cart list looks incomplete or empty, that is a display lag, not permission to restart the order. Always reply as a continuation of the conversation so far, picking up exactly where the last message left off (e.g. moving on to the next step, or answering their latest message) — never repeat an earlier reply verbatim or re-introduce an item you already confirmed.

--- Already ordered for this table (fetched fresh just now — this is the CURRENT, AUTHORITATIVE record; it is NOT the same thing as what you remember from earlier in this conversation, and it stays accurate even if this is a brand-new chat session) ---
${orderStateText}`;

    const chatTools = buildGroqChatTools(runnerOptions);

    const apiMessages = [
      { role: "system", content: systemContent },
      ...history,
      { role: "system", content: PERSONA_ANCHOR_SYSTEM_MESSAGE },
    ];

    const completion = await createGroqChatCompletionWithTools({
      model: GROQ_CHAT_MODEL,
      messages: apiMessages,
      tools: chatTools,
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
