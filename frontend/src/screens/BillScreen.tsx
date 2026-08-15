import { useCallback, useEffect, useMemo, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { io, type Socket } from "socket.io-client";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CustomerStackParamList } from "../navigation/types";
import { MENU_API_BASE } from "../services/menuApi";
import {
  fetchUnpaidOrders,
  payForTable,
  type ActiveOrder,
} from "../services/orderApi";
import { useSimulatorStore } from "../simulator/simulatorStore";
import { useChatWaiterStore } from "../store/chatWaiterStore";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<CustomerStackParamList, "Bill">;

function formatPlacedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BillScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const guestTableId = useSimulatorStore((s) => s.guestTableId);

  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  /** True right after a successful payment — shows the Thank You view instead of the bill. */
  const [paid, setPaid] = useState(false);

  const loadBill = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const data = await fetchUnpaidOrders();
      setOrders(data);
      if (silent) setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not load your bill";
      if (silent) {
        console.warn("[Bill] Silent refresh failed:", message);
      } else {
        setError(message);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Freshly focusing the Bill screen (e.g. asking for the check on a NEW
  // order after paying) should always show the live bill, not a stale
  // Thank You view from a previous payment.
  useFocusEffect(
    useCallback(() => {
      setPaid(false);
      void loadBill();
    }, [loadBill])
  );

  useEffect(() => {
    const baseUrl = (MENU_API_BASE ?? "").toString().trim();
    if (!baseUrl) return;
    const socket: Socket = io(baseUrl, { transports: ["websocket", "polling"] });
    const onChanged = () => void loadBill({ silent: true });
    socket.on("order_created", onChanged);
    socket.on("order_status_changed", onChanged);
    socket.on("order_item_status_changed", onChanged);
    socket.on("table_paid", onChanged);
    return () => {
      socket.off("order_created", onChanged);
      socket.off("order_status_changed", onChanged);
      socket.off("order_item_status_changed", onChanged);
      socket.off("table_paid", onChanged);
      socket.disconnect();
    };
  }, [loadBill]);

  const tableOrders = useMemo(
    () => orders.filter((o) => o.table_id === guestTableId),
    [orders, guestTableId]
  );

  const grandTotal = useMemo(
    () => tableOrders.reduce((sum, o) => sum + o.total_price, 0),
    [tableOrders]
  );

  const onPay = useCallback(async () => {
    if (tableOrders.length === 0 || paying) return;
    setPaying(true);
    try {
      await payForTable(guestTableId);
      // Clear the cart + chat history for the next guest, but deliberately
      // do NOT touch guestTableId / isGuestTableLocked here — this table
      // stays locked to the same tableId from the QR deep link. (The old
      // bug: this used to call resetSimulator(), which also resets
      // guestTableId back to the "T12" default and unlocks it.)
      useSimulatorStore.getState().clearGuestCart();
      useChatWaiterStore.getState().resetToWelcome();
      setPaid(true);
    } catch (e) {
      Alert.alert(
        "Could not pay",
        e instanceof Error ? e.message : "Please try again."
      );
    } finally {
      setPaying(false);
    }
  }, [tableOrders, guestTableId, paying]);

  const onBackToWelcome = useCallback(() => {
    navigation.navigate("Chat");
  }, [navigation]);

  const listPaddingBottom = 140 + insets.bottom;

  if (paid) {
    return (
      <View style={[styles.root, styles.thankYouRoot]}>
        <Text style={styles.thankYouCheck}>✓</Text>
        <Text style={styles.thankYouTitle}>Thank You!</Text>
        <Text style={styles.thankYouSubtitle}>
          Your bill for Table {guestTableId} has been paid.{"\n"}
          The table is fresh and ready for your next order.
        </Text>
        <Pressable
          style={({ pressed }) => [
            styles.primary,
            styles.thankYouBtn,
            pressed && styles.primaryPressed,
          ]}
          onPress={onBackToWelcome}
        >
          <Text style={styles.primaryText}>Back to AI Waiter</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {loading ? (
        <View style={styles.loadingBanner}>
          <ActivityIndicator size="large" color={premium.gold} />
        </View>
      ) : error != null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void loadBill()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          style={styles.listFlex}
          data={tableOrders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: listPaddingBottom },
          ]}
          ListHeaderComponent={
            <View style={styles.listHero}>
              <Text style={styles.kicker}>TABLE {guestTableId || "—"}</Text>
              <Text style={styles.heroTitle}>Your Bill</Text>
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No orders yet for this table — nothing to pay.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.placedAt}>
                  Placed at {formatPlacedAt(item.created_at)}
                </Text>
                <Text style={styles.statusBadge}>{item.status}</Text>
              </View>
              {item.items.map((line) => (
                <View key={line.id} style={styles.itemRow}>
                  <Text style={styles.itemLine} numberOfLines={2}>
                    {line.quantity} × {line.menu_item_name}
                  </Text>
                  <Text style={styles.itemPrice}>
                    ${(line.unit_price * line.quantity).toFixed(2)}
                  </Text>
                </View>
              ))}
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>Subtotal</Text>
                <Text style={styles.subtotalValue}>
                  ${item.total_price.toFixed(2)}
                </Text>
              </View>
            </View>
          )}
        />
      )}

      <View
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}
      >
        <View style={styles.footerRow}>
          <View>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.total}>${grandTotal.toFixed(2)}</Text>
          </View>
          <Text style={styles.footerMeta}>
            {tableOrders.length === 0
              ? "No orders"
              : `${tableOrders.length} order${tableOrders.length === 1 ? "" : "s"}`}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.primary,
            (tableOrders.length === 0 || loading || paying) &&
              styles.primaryDisabled,
            pressed &&
              tableOrders.length > 0 &&
              !loading &&
              !paying &&
              styles.primaryPressed,
          ]}
          onPress={() => void onPay()}
          disabled={tableOrders.length === 0 || loading || paying}
        >
          <Text style={styles.primaryText}>
            {paying ? "Processing…" : "Pay Now"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: premium.screen },
  thankYouRoot: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 14,
  },
  thankYouCheck: {
    fontSize: 56,
    color: premium.runner,
    fontWeight: "800",
    marginBottom: 4,
  },
  thankYouTitle: {
    fontSize: 30,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.6,
  },
  thankYouSubtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: premium.muted,
    textAlign: "center",
  },
  thankYouBtn: {
    marginTop: 18,
    paddingHorizontal: 32,
    alignSelf: "center",
  },
  listFlex: { flex: 1 },
  loadingBanner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorBanner: {
    flex: 1,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  errorText: {
    fontSize: 15,
    color: "#DC2626",
    textAlign: "center",
    lineHeight: 22,
  },
  retryBtn: {
    backgroundColor: premium.goldDark,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  retryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  listContent: { paddingHorizontal: 20, paddingTop: 8 },
  listHero: { marginBottom: 12 },
  kicker: {
    fontSize: 12,
    fontWeight: "700",
    color: premium.goldDark,
    letterSpacing: 2.5,
    marginBottom: 6,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.6,
  },
  emptyText: {
    fontSize: 15,
    color: premium.muted,
    marginTop: 24,
    textAlign: "center",
  },
  card: {
    backgroundColor: premium.ivory,
    borderRadius: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: premium.border,
    borderTopWidth: 3,
    borderTopColor: premium.gold,
    padding: 18,
    gap: 10,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  placedAt: { fontSize: 13, fontWeight: "700", color: premium.muted },
  statusBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: premium.goldDark,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  itemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  itemLine: { flex: 1, fontSize: 15, color: premium.charcoalSoft },
  itemPrice: { fontSize: 15, fontWeight: "700", color: premium.charcoal },
  subtotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: premium.border,
    paddingTop: 10,
    marginTop: 2,
  },
  subtotalLabel: { fontSize: 13, fontWeight: "700", color: premium.muted },
  subtotalValue: { fontSize: 16, fontWeight: "800", color: premium.goldDark },

  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    paddingTop: 20,
    backgroundColor: premium.navBar,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    gap: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 12,
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  totalLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(255,255,255,0.55)",
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  total: {
    fontSize: 32,
    fontWeight: "800",
    color: premium.navAccent,
    letterSpacing: -0.5,
  },
  footerMeta: { fontSize: 14, color: "rgba(255,255,255,0.5)", marginBottom: 4 },
  primary: {
    backgroundColor: premium.goldBright,
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryDisabled: { backgroundColor: premium.muted, opacity: 0.5 },
  primaryPressed: { backgroundColor: premium.gold },
  primaryText: {
    color: premium.charcoal,
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
});
