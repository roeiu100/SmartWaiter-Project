import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { io, type Socket } from "socket.io-client";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { MENU_API_BASE } from "../services/menuApi";
import {
  sendChatToApi,
  type ChatCartLine,
  type ChatMessage,
  type ParsedToolCall,
} from "../services/chatApi";
import { useSimulatorStore } from "../simulator/simulatorStore";
import { useChatWaiterStore } from "../store/chatWaiterStore";
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

function isRateLimitedChatError(message: string): boolean {
  return /429|rate limit|rate_limit|tokens per day|usage limit|temporarily unavailable/i.test(
    message
  );
}

function friendlyChatFailureMessage(raw: string, lang: "he" | "en"): string {
  if (isRateLimitedChatError(raw)) {
    return lang === "he"
      ? "המלצר הווירטואלי לא זמין רגע בגלל מגבלת שימוש. נסו שוב בעוד כמה דקות."
      : "The AI waiter is briefly unavailable due to a usage limit. Please try again in a few minutes.";
  }
  if (raw.length > 220) {
    return lang === "he"
      ? "לא הצלחנו להתחבר לשירות המלצר. נסו שוב."
      : "We couldn't reach the waiter service. Please try again.";
  }
  return raw;
}

/** User said they don't want more items (not e.g. "no tomatoes"). */
function userDeclinesFurtherItems(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const t = raw.toLowerCase();
  if (
    /^(no|nope|no thanks|no thank you|nothing else|that'?s all|that is all|all set|i'?m good|we'?re good)\.?$/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^לא(\s+תודה)?\.?$/i.test(raw)) return true;
  if (/^(זהו|סיימתי)\.?$/i.test(raw)) return true;
  return false;
}

type SubmitOutcome = "ok" | "empty" | "error" | null;

function cartLinesFromStore(): ChatCartLine[] {
  const qty = useSimulatorStore.getState().guestCartQuantities;
  return Object.entries(qty)
    .filter(([, q]) => (Number(q) || 0) > 0)
    .map(([menu_item_id, quantity]) => ({
      menu_item_id,
      quantity: Number(quantity),
    }));
}

export function ChatScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const messages = useChatWaiterStore((s) => s.messages);
  const appendMessage = useChatWaiterStore((s) => s.appendMessage);
  const guestTableId = useSimulatorStore((s) => s.guestTableId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [managerModalVisible, setManagerModalVisible] = useState(false);
  const [managerReason, setManagerReason] = useState("");
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const baseUrl =
      (MENU_API_BASE ?? process.env.EXPO_PUBLIC_API_URL ?? "").toString().trim();
    if (!baseUrl) {
      console.warn(
        "[Chat] MENU_API_BASE / EXPO_PUBLIC_API_URL not set; manager socket disabled"
      );
      return;
    }

    console.log("[Chat] connecting manager socket to", baseUrl);
    const socket = io(baseUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
    });
    socketRef.current = socket;

    const onConnect = () => {
      console.log("[Chat] manager socket connected:", socket.id);
    };
    const onConnectError = (err: Error) => {
      console.warn("[Chat] manager socket connect_error:", err?.message ?? err);
    };
    const onDisconnect = (reason: string) => {
      console.log("[Chat] manager socket disconnected:", reason);
    };
    const onManagerError = (payload: { error?: string } | undefined) => {
      console.warn("[Chat] manager_error received:", payload);
      Alert.alert(
        "Manager unavailable",
        "Manager requests are currently disabled for this table."
      );
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    socket.on("manager_error", onManagerError);

    return () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
      socket.off("manager_error", onManagerError);
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, []);

  const onSubmitManagerCall = useCallback(() => {
    const reason = managerReason.trim();
    if (!reason) {
      Alert.alert("Reason required", "Please enter a reason for calling the manager.");
      return;
    }
    const socket = socketRef.current;
    if (!socket) {
      Alert.alert(
        "Unavailable",
        "Manager service is not connected. Please try again shortly."
      );
      return;
    }
    const table = (guestTableId ?? "").trim() || "T?";
    // Socket.io buffers emits until the underlying connection is ready,
    // so we don't need to block on socket.connected here. We pass an ACK
    // callback so we only show the "Manager notified" alert when the server
    // confirms success. When the table is blocked, the server instead
    // emits `manager_error` (handled separately) and the ack returns
    // { ok: false }, so we skip the success alert and avoid a double popup.
    socket.emit(
      "call_manager",
      { table, reason },
      (response: { ok?: boolean; code?: string } | undefined) => {
        console.log("[Chat] call_manager ack:", response);
        if (response && response.ok === true) {
          Alert.alert(
            "Manager notified",
            "A manager has been alerted and will come to your table."
          );
        }
      }
    );
    console.log("[Chat] emitted call_manager", {
      table,
      reason,
      connected: socket.connected,
    });
    setManagerReason("");
    setManagerModalVisible(false);
  }, [managerReason, guestTableId]);

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

  const applyToolCalls = useCallback((tool_calls: ParsedToolCall[]) => {
    for (const tc of tool_calls) {
      if (normToolName(tc.name) === "request_runner") {
        // Side effect (emitting the runner alert) is handled by the server
        // in POST /api/chat so the Runner tablet sees it immediately. We
        // just log it here for debugging.
        console.log("[Chat] Tool call (request_runner):", tc);
        continue;
      }
      if (normToolName(tc.name) !== "update_cart") continue;

      console.log("[Chat] Tool call (update_cart):", tc);
      if (!tc.arguments || typeof tc.arguments !== "object") continue;

      const { item_id, quantity } = tc.arguments as {
        item_id?: unknown;
        quantity?: unknown;
      };
      const id = item_id != null ? String(item_id) : "";
      const qty = Number(quantity);
      if (id && Number.isFinite(qty)) {
        useSimulatorStore.getState().setGuestCartLine(id, qty);
      }
    }
  }, []);

  const onSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setErrorBanner(null);
    const userMsg: ChatMessage = { role: "user", content: trimmed };
    appendMessage(userMsg);
    const historyForApi = useChatWaiterStore.getState().messages;

    setInput("");
    setSending(true);

    const lang = lastUserLanguage(historyForApi);

    try {
      const cart = cartLinesFromStore();
      const { assistantText, tool_calls, order, order_error } =
        await sendChatToApi(historyForApi, guestTableId, cart);

      if (tool_calls.length > 0) {
        applyToolCalls(tool_calls);
      }

      const hadSubmitOrder = tool_calls.some(
        (t) =>
          normToolName(t.name) === "submit_order" || t.name === "submit_order"
      );

      let submitOutcome: SubmitOutcome = null;
      if (hadSubmitOrder) {
        if (order) {
          submitOutcome = "ok";
          useSimulatorStore.getState().clearGuestCart();
        } else if (order_error && /empty|no valid|no available/i.test(order_error.message)) {
          submitOutcome = "empty";
        } else if (order_error) {
          submitOutcome = "error";
          console.warn("[Chat] submit_order server rejected:", order_error);
        } else {
          // Tool fired but no cart was sent — treat as empty.
          submitOutcome = "empty";
        }
      }

      let combined = (assistantText && assistantText.trim()) || "";
      // Take the LAST tool call that carries a valid guest_reply (don't mutate tool_calls).
      const toolWithGuestReply = [...tool_calls]
        .reverse()
        .find(
          (t) =>
            t.arguments &&
            typeof t.arguments.guest_reply === "string" &&
            t.arguments.guest_reply.trim().length > 0
        );
      if (
        toolWithGuestReply &&
        toolWithGuestReply.arguments &&
        typeof toolWithGuestReply.arguments.guest_reply === "string"
      ) {
        combined = toolWithGuestReply.arguments.guest_reply.trim();
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

      if (!String(combined).trim()) {
        combined = userDeclinesFurtherItems(trimmed)
          ? lang === "he"
            ? "לא הצלחתי לסגור את ההזמנה מההודעה הזו. כתבו ״שלח למטבח״ כדי לאשר, או שלחו שוב ״לא, תודה״."
            : "I couldn’t finalize from that reply. Type **send to kitchen** to confirm, or send **No** / **No thanks** again."
          : lang === "he"
            ? "לא הבנתי לגמרי. תוכלו לפרט או לנסח שוב?"
            : "I didn't quite catch that. Could you say it another way?";
      }

      appendMessage({ role: "assistant", content: combined });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Something went wrong.";
      const friendly = friendlyChatFailureMessage(raw, lang);
      setErrorBanner(friendly);
      console.error("[Chat] send failed:", e);
      appendMessage({
        role: "assistant",
        content: friendly,
      });
    } finally {
      setSending(false);
    }
  }, [input, sending, applyToolCalls, appendMessage, guestTableId]);
    
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
      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Call the manager"
          onPress={() => setManagerModalVisible(true)}
          style={({ pressed }) => [
            styles.callManagerBtn,
            pressed && styles.callManagerBtnPressed,
          ]}
        >
          <Text style={styles.callManagerBtnLabel}>Call Manager</Text>
        </Pressable>
      </View>

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

        <Modal
          visible={managerModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setManagerModalVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Call Manager</Text>
              <Text style={styles.modalSubtitle}>
                Reason for calling the manager
              </Text>
              <TextInput
                style={styles.modalInput}
                value={managerReason}
                onChangeText={setManagerReason}
                placeholder="e.g. wrong order, billing question…"
                placeholderTextColor={premium.mutedLight}
                multiline
                maxLength={400}
                autoFocus
              />
              <View style={styles.modalActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  onPress={() => {
                    setManagerReason("");
                    setManagerModalVisible(false);
                  }}
                  style={({ pressed }) => [
                    styles.modalBtn,
                    styles.modalBtnSecondary,
                    pressed && styles.modalBtnPressed,
                  ]}
                >
                  <Text style={styles.modalBtnSecondaryLabel}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Submit manager request"
                  onPress={onSubmitManagerCall}
                  disabled={!managerReason.trim()}
                  style={({ pressed }) => [
                    styles.modalBtn,
                    styles.modalBtnPrimary,
                    !managerReason.trim() && styles.modalBtnDisabled,
                    pressed && managerReason.trim() && styles.modalBtnPressed,
                  ]}
                >
                  <Text style={styles.modalBtnPrimaryLabel}>Submit</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
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
  topBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    backgroundColor: premium.screenDeep,
  },
  callManagerBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: premium.navBar,
  },
  callManagerBtnPressed: {
    opacity: 0.85,
  },
  callManagerBtnLabel: {
    color: premium.onNav,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0.3,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: premium.ivory,
    borderRadius: 16,
    padding: 18,
    gap: 10,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: premium.charcoal,
  },
  modalSubtitle: {
    fontSize: 13,
    color: premium.charcoal,
    opacity: 0.7,
  },
  modalInput: {
    minHeight: 80,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: premium.charcoal,
    backgroundColor: premium.ivoryDark,
    borderWidth: 1,
    borderColor: premium.border,
    textAlignVertical: "top",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    minWidth: 92,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnPrimary: {
    backgroundColor: premium.navBar,
  },
  modalBtnSecondary: {
    backgroundColor: premium.ivoryDark,
    borderWidth: 1,
    borderColor: premium.border,
  },
  modalBtnDisabled: {
    opacity: 0.45,
  },
  modalBtnPressed: {
    opacity: 0.88,
  },
  modalBtnPrimaryLabel: {
    color: premium.onNav,
    fontWeight: "700",
    fontSize: 15,
  },
  modalBtnSecondaryLabel: {
    color: premium.charcoal,
    fontWeight: "600",
    fontSize: 15,
  },
});
