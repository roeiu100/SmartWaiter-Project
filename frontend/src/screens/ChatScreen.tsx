import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { fetchMenuFromApi } from "../services/menuApi";
import {
  sendChatToApi,
  type ChatMessage,
  type ParsedToolCall,
} from "../services/chatApi";
import { useSimulatorStore } from "../simulator/simulatorStore";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Chat">;

function normToolName(name: string | null | undefined): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function lastUserLanguage(messages: ChatMessage[]): "he" | "en" {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content.trim()) {
      return /[\u0590-\u05FF]/.test(messages[i].content) ? "he" : "en";
    }
  }
  return "en";
}

type SubmitOutcome = "ok" | "empty" | "error" | null;

async function submitOrderToKitchenSimulator(): Promise<SubmitOutcome> {
  try {
    const menu = await fetchMenuFromApi();
    return useSimulatorStore.getState().submitGuestCartToKitchen(menu);
  } catch (e) {
    console.error("[Chat] submitGuestCartToKitchen / fetch menu failed:", e);
    return "error";
  }
}

export function ChatScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hi — I'm your AI waiter. Ask about the menu or tell me what you'd like to order.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => {
        requestAnimationFrame(() =>
          listRef.current?.scrollToEnd({ animated: true })
        );
      }
    );
    return () => show.remove();
  }, []);

  const applyToolCalls = useCallback(async (tool_calls: ParsedToolCall[]) => {
    for (const tc of tool_calls) {
      if (normToolName(tc.name) !== "update_cart") continue;

      console.log("[Chat] Tool call (update_cart):", tc);

      if (!tc.arguments || typeof tc.arguments !== "object") continue;

      const { item_id, quantity, special_requests } = tc.arguments as {
        item_id?: unknown;
        quantity?: unknown;
        special_requests?: unknown;
      };
      console.log("[Chat] update_cart payload:", {
        item_id,
        quantity,
        special_requests,
      });
      const id = item_id != null ? String(item_id) : "";
      const qty = Number(quantity);
      if (id && Number.isFinite(qty)) {
        useSimulatorStore.getState().setGuestCartLine(id, qty);
      }
    }

    let submitOutcome: SubmitOutcome = null;
    const wantsSubmit = tool_calls.some(
      (tc) =>
        normToolName(tc.name) === "submit_order" ||
        tc.name === "submit_order"
    );

    if (wantsSubmit) {
      console.log(
        "[Chat] submit_order detected — invoking submitGuestCartToKitchen (same as Guest checkout)",
        JSON.stringify(tool_calls.map((t) => ({ name: t.name, args: t.arguments })))
      );
      submitOutcome = await submitOrderToKitchenSimulator();

      if (submitOutcome === "ok") {
        Alert.alert("Success", "Order sent to kitchen!");
        useSimulatorStore.getState().clearGuestCart();
      } else if (submitOutcome === "empty") {
        Alert.alert(
          "Cannot send",
          "Your cart is empty or has no available items to send."
        );
      } else {
        Alert.alert("Error", "Could not send the order. Please try again.");
      }
    }

    return { submitOutcome };
  }, []);

  const onSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setErrorBanner(null);
    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const historyForApi: ChatMessage[] = [...messages, userMsg];

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    const lang = lastUserLanguage([...messages, userMsg]);

    try {
      const { assistantText, tool_calls } = await sendChatToApi(historyForApi);

      let submitOutcome: SubmitOutcome = null;
      if (tool_calls.length > 0) {
        const r = await applyToolCalls(tool_calls);
        submitOutcome = r.submitOutcome;
      }

      const hadUpdateCart = tool_calls.some(
        (t) => normToolName(t.name) === "update_cart"
      );
      const hadSubmitOrder = tool_calls.some(
        (t) =>
          normToolName(t.name) === "submit_order" || t.name === "submit_order"
      );

      let combined = (assistantText && assistantText.trim()) || "";

      if (!combined && hadUpdateCart) {
        combined =
          lang === "he"
            ? "עדכנתי את העגלה."
            : "I've updated your cart.";
      }

      if (hadSubmitOrder) {
        if (submitOutcome === "ok") {
          combined = combined
            ? `${combined}\n\n${lang === "he" ? "ההזמנה נשלחה למטבח." : "Your order was sent to the kitchen."}`
            : lang === "he"
              ? "ההזמנה נשלחה למטבח."
              : "Your order was sent to the kitchen.";
        } else if (submitOutcome === "empty") {
          combined = combined
            ? `${combined}\n\n${lang === "he" ? "לא ניתן לשלוח — העגלה ריקה או שאין פריטים זמינים." : "Couldn't send — cart is empty or has no available items."}`
            : lang === "he"
              ? "לא ניתן לשלוח — העגלה ריקה או שאין פריטים זמינים."
              : "Couldn't send — cart is empty or has no available items.";
        } else if (submitOutcome === "error") {
          combined = combined
            ? `${combined}\n\n${lang === "he" ? "שגיאה בשליחת ההזמנה." : "There was an error sending your order."}`
            : lang === "he"
              ? "שגיאה בשליחת ההזמנה."
              : "There was an error sending your order.";
        }
      }

      if (!combined) {
        combined =
          lang === "he"
            ? "לא קיבלתי תשובה. נסו שוב."
            : "I didn't get a reply. Please try again.";
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: combined },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      setErrorBanner(msg);
      console.error("[Chat] send failed:", e);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            lang === "he"
              ? `מצטערים — לא הצלחתי להתחבר לשירות. (${msg})`
              : `Sorry — I couldn't reach the waiter service. (${msg})`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, messages, sending, applyToolCalls]);

  const renderItem = useCallback(
    ({ item: m }: { item: ChatMessage }) => {
      const isUser = m.role === "user";
      return (
        <View
          style={[
            styles.bubbleRow,
            isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant,
          ]}
        >
          <View
            style={[
              styles.bubble,
              isUser ? styles.bubbleUser : styles.bubbleAssistant,
            ]}
          >
            <Text
              style={[
                styles.bubbleText,
                isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant,
              ]}
            >
              {m.content}
            </Text>
          </View>
        </View>
      );
    },
    []
  );

  return (
    <KeyboardAvoidingView
      style={styles.chatRoot}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={listRef}
        style={styles.list}
        data={messages}
        keyExtractor={(_, index) => `msg-${index}`}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.listContent, { paddingTop: 12, paddingBottom: 12 }]}
        onContentSizeChange={() =>
          listRef.current?.scrollToEnd({ animated: true })
        }
      />

        {errorBanner ? (
          <View style={styles.errorStrip}>
            <Text style={styles.errorStripText}>{errorBanner}</Text>
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="Message your waiter…"
              placeholderTextColor={premium.mutedLight}
              multiline
              maxLength={2000}
              editable={!sending}
              blurOnSubmit={false}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              onPress={() => void onSend()}
              disabled={sending || !input.trim()}
              style={({ pressed }) => [
                styles.sendBtn,
                (sending || !input.trim()) && styles.sendBtnDisabled,
                pressed && !(sending || !input.trim()) && styles.sendBtnPressed,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={premium.onNav} size="small" />
              ) : (
                <Text style={styles.sendBtnLabel}>Send</Text>
              )}
            </Pressable>
          </View>
        </View>
    </KeyboardAvoidingView>
  );
}

const BUBBLE_MAX = "82%";

const styles = StyleSheet.create({
  chatRoot: {
    flex: 1,
    backgroundColor: premium.screenDeep,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 14,
  },
  bubbleRow: {
    marginBottom: 10,
    maxWidth: "100%",
  },
  bubbleRowUser: {
    alignItems: "flex-end",
  },
  bubbleRowAssistant: {
    alignItems: "flex-start",
  },
  bubble: {
    maxWidth: BUBBLE_MAX,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
  },
  bubbleUser: {
    backgroundColor: premium.gold,
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: premium.ivory,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: premium.border,
  },
  bubbleText: {
    fontSize: 16,
    lineHeight: 22,
  },
  bubbleTextUser: {
    color: premium.charcoal,
    fontWeight: "500",
  },
  bubbleTextAssistant: {
    color: premium.charcoal,
  },
  errorStrip: {
    backgroundColor: "#FEE2E2",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  errorStripText: {
    color: "#991B1B",
    fontSize: 13,
    textAlign: "center",
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: premium.border,
    backgroundColor: premium.ivory,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: premium.charcoal,
    backgroundColor: premium.ivoryDark,
    borderWidth: 1,
    borderColor: premium.border,
  },
  sendBtn: {
    minWidth: 72,
    height: 44,
    borderRadius: 22,
    backgroundColor: premium.navBar,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  sendBtnDisabled: {
    opacity: 0.45,
  },
  sendBtnPressed: {
    opacity: 0.88,
  },
  sendBtnLabel: {
    color: premium.onNav,
    fontWeight: "700",
    fontSize: 16,
  },
});
