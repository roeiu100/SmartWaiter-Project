import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  FlatList,
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
import {
  sendChatToApi,
  type ChatMessage,
  type ParsedToolCall,
} from "../services/chatApi";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Chat">;

export function ChatScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hi — I'm your AI waiter. Ask about the menu, pairings, or tell me what you'd like and I can help build your order.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  const handleToolCalls = useCallback((tool_calls: ParsedToolCall[]) => {
    for (const tc of tool_calls) {
      console.log("[Chat] Tool call from AI waiter:", tc);
      if (
        tc.name === "update_cart" &&
        tc.arguments &&
        typeof tc.arguments === "object"
      ) {
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
        // -------------------------------------------------------------------------
        // TODO (Zustand cart): apply AI line items here, e.g.:
        //   useCartStore.getState().setLine(String(item_id), Number(quantity), String(special_requests ?? ''))
        // SmartWaiter today keeps cart in GuestMenuScreen local state; consider
        // moving quantities into simulatorStore (or a dedicated cart slice) so
        // this screen and the menu share one source of truth.
        // -------------------------------------------------------------------------
      }
    }
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

    try {
      const { assistantText, tool_calls } = await sendChatToApi(historyForApi);

      if (tool_calls.length > 0) {
        handleToolCalls(tool_calls);
      }

      const toolSummary =
        tool_calls.length > 0
          ? summarizeToolCallsForUi(tool_calls)
          : null;

      const combined =
        assistantText ||
        (toolSummary
          ? `I've noted your cart changes.${toolSummary ? `\n\n${toolSummary}` : ""}`
          : "Done.");

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
          content: `Sorry — I couldn't reach the waiter service. (${msg})`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, messages, sending, handleToolCalls]);

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
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, index) => `msg-${index}`}
        renderItem={renderItem}
        contentContainerStyle={[
          styles.listContent,
          { paddingTop: 12, paddingBottom: 12 },
        ]}
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
          {
            paddingBottom: Math.max(insets.bottom, 12),
            paddingTop: 10,
          },
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

function summarizeToolCallsForUi(tool_calls: ParsedToolCall[]): string {
  const lines: string[] = [];
  for (const tc of tool_calls) {
    if (tc.name !== "update_cart" || !tc.arguments) continue;
    const a = tc.arguments;
    const id = a.item_id != null ? String(a.item_id) : "?";
    const q = a.quantity != null ? String(a.quantity) : "?";
    const note =
      a.special_requests != null && String(a.special_requests).trim()
        ? ` · ${String(a.special_requests).trim()}`
        : "";
    lines.push(`• Cart: item ${id} × ${q}${note}`);
  }
  return lines.length > 0 ? lines.join("\n") : "";
}

const BUBBLE_MAX = "82%";

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: premium.screenDeep,
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
