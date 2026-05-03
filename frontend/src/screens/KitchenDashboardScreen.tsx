import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { io, type Socket } from "socket.io-client";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { MENU_API_BASE } from "../services/menuApi";
import {
  fetchActiveOrders,
  normalizeActiveOrder,
  patchItemStatus,
  type ActiveOrder,
  type ActiveOrderItem,
  type ActiveOrderItemStatus,
} from "../services/orderApi";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Kitchen">;

/** After 15 minutes the card turns pink to alert chefs. */
const STALE_AFTER_MS = 15 * 60 * 1000;
const TICK_MS = 30 * 1000;

const KITCHEN_SOCKET_URL = (MENU_API_BASE ?? "").toString().trim();

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = minutes.toString().padStart(2, "0");
  const ss = seconds.toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Derived kitchen queue: orders that still have pending items to prepare. */
function getKitchenQueue(orders: ActiveOrder[]): ActiveOrder[] {
  return orders.filter(
    (o) =>
      o.status !== "delivered" &&
      o.items.some((it) => it.status === "pending")
  );
}

export function KitchenDashboardScreen(_props: Props) {
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const queue = useMemo(() => getKitchenQueue(orders), [orders]);

  const reload = useCallback(async () => {
    try {
      const list = await fetchActiveOrders();
      setOrders(list);
      setLoadError(null);
    } catch (err) {
      console.warn("[Kitchen] fetchActiveOrders failed:", err);
      setLoadError(err instanceof Error ? err.message : "Could not load orders");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!KITCHEN_SOCKET_URL) {
      console.warn("[Kitchen] MENU_API_BASE is not set; sockets disabled");
      return;
    }
    const s = io(KITCHEN_SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
    });
    socketRef.current = s;

    const onConnect = () => {
      console.log("[Kitchen] socket connected:", s.id);
      void reload();
    };
    const onConnectError = (err: Error) => {
      console.warn("[Kitchen] socket connect_error:", err?.message ?? err);
    };
    const onOrderCreated = (data: unknown) => {
      const order = normalizeActiveOrder(data);
      if (!order) return;
      setOrders((prev) =>
        prev.some((o) => o.id === order.id) ? prev : [...prev, order]
      );
    };
    const onItemStatusChanged = (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const {
        order_id,
        item_id,
        status,
        ready_at,
        served_at,
      } = data as {
        order_id?: string;
        item_id?: string;
        status?: ActiveOrderItemStatus;
        ready_at?: string;
        served_at?: string;
      };
      if (!order_id || !item_id || !status) return;
      setOrders((prev) =>
        prev.map((o) => {
          if (o.id !== order_id) return o;
          return {
            ...o,
            items: o.items.map((it) =>
              it.id !== item_id
                ? it
                : {
                    ...it,
                    status,
                    ready_at:
                      status === "ready" ? ready_at ?? it.ready_at : it.ready_at,
                    served_at:
                      status === "served"
                        ? served_at ?? it.served_at
                        : it.served_at,
                  }
            ),
          };
        })
      );
    };
    const onOrderStatusChanged = (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const { order_id, status } = data as {
        order_id?: string;
        status?: ActiveOrder["status"];
      };
      if (!order_id || !status) return;
      setOrders((prev) => {
        if (status === "delivered") {
          return prev.filter((o) => o.id !== order_id);
        }
        return prev.map((o) => (o.id === order_id ? { ...o, status } : o));
      });
    };

    s.on("connect", onConnect);
    s.on("connect_error", onConnectError);
    s.on("order_created", onOrderCreated);
    s.on("order_item_status_changed", onItemStatusChanged);
    s.on("order_status_changed", onOrderStatusChanged);

    return () => {
      s.off("connect", onConnect);
      s.off("connect_error", onConnectError);
      s.off("order_created", onOrderCreated);
      s.off("order_item_status_changed", onItemStatusChanged);
      s.off("order_status_changed", onOrderStatusChanged);
      s.disconnect();
      if (socketRef.current === s) socketRef.current = null;
    };
  }, [reload]);

  // Tick for elapsed time labels.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Manual ordering of order IDs (long-press "Move to Start" pushes to index 0).
  const [manualOrderIds, setManualOrderIds] = useState<string[]>([]);

  const displayQueue = useMemo<ActiveOrder[]>(() => {
    const byId = new Map(queue.map((o) => [o.id, o]));
    const seen = new Set<string>();
    const ordered: ActiveOrder[] = [];
    for (const id of manualOrderIds) {
      const o = byId.get(id);
      if (o) {
        ordered.push(o);
        seen.add(id);
      }
    }
    const newcomers = queue.filter((o) => !seen.has(o.id));
    return [...newcomers, ...ordered];
  }, [queue, manualOrderIds]);

  const flipItemStatus = useCallback(
    async (
      orderId: string,
      itemId: string,
      nextStatus: ActiveOrderItemStatus
    ) => {
      const snapshot = orders;
      setOrders((prev) =>
        prev.map((o) =>
          o.id !== orderId
            ? o
            : {
                ...o,
                items: o.items.map((it) =>
                  it.id === itemId ? { ...it, status: nextStatus } : it
                ),
              }
        )
      );
      try {
        await patchItemStatus(orderId, itemId, nextStatus);
      } catch (err) {
        console.warn("[Kitchen] patchItemStatus failed:", err);
        setOrders(snapshot);
        Alert.alert(
          "Could not update",
          err instanceof Error ? err.message : "Server rejected the update"
        );
      }
    },
    [orders]
  );

  const toggleItemReady = useCallback(
    (orderId: string, itemId: string, currentStatus: ActiveOrderItemStatus) => {
      if (currentStatus === "served") return;
      const next: ActiveOrderItemStatus =
        currentStatus === "ready" ? "pending" : "ready";
      void flipItemStatus(orderId, itemId, next);
    },
    [flipItemStatus]
  );

  const markAllAsReady = useCallback(
    async (order: ActiveOrder) => {
      for (const line of order.items) {
        if (line.status === "pending") {
          await flipItemStatus(order.id, line.id, "ready");
        }
      }
      setManualOrderIds((prev) => prev.filter((id) => id !== order.id));
    },
    [flipItemStatus]
  );

  const moveToStart = (orderId: string) => {
    const currentIds = displayQueue.map((o) => o.id);
    if (currentIds.length === 0 || currentIds[0] === orderId) return;
    const rest = currentIds.filter((id) => id !== orderId);
    setManualOrderIds([orderId, ...rest]);
  };

  const handleLongPress = (order: ActiveOrder) => {
    Alert.alert(
      `Table ${order.table_id}`,
      "Expediter options",
      [
        { text: "Move to front", onPress: () => moveToStart(order.id) },
        {
          text: "Mark all as ready",
          onPress: () => void markAllAsReady(order),
        },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true }
    );
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.screen}
      contentContainerStyle={styles.container}
    >
      <View style={styles.intro}>
        <Text style={styles.introKicker}>KITCHEN</Text>
        <Text style={styles.introTitle}>Order queue</Text>
        <View style={styles.introRule} />
        <Text style={styles.hint}>
          Tap a dish to mark it ready for the runner. Long-press a ticket
          for more options.
        </Text>
      </View>

      {loadError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void reload()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {displayQueue.length === 0 && !loadError ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>◇</Text>
          <Text style={styles.emptyTitle}>All caught up</Text>
          <Text style={styles.emptyText}>No active tickets</Text>
        </View>
      ) : (
        displayQueue.map((order) => {
          const orderStart = new Date(order.created_at).getTime();
          const ageMs = Math.max(0, now - orderStart);
          const isStale = ageMs >= STALE_AFTER_MS;
          return (
            <Pressable
              key={order.id}
              accessibilityRole="button"
              accessibilityLabel={`Ticket for table ${order.table_id}. Long press for options.`}
              onLongPress={() => handleLongPress(order)}
              delayLongPress={350}
              style={({ pressed }) => [
                styles.card,
                isStale && styles.cardStale,
                pressed && styles.cardPressed,
              ]}
            >
              <View style={styles.cardHeader}>
                <View style={styles.cardHeaderMain}>
                  <Text
                    style={[
                      styles.tableLabel,
                      isStale && styles.tableLabelStale,
                    ]}
                  >
                    Table
                  </Text>
                  <Text style={styles.tableName} numberOfLines={1}>
                    {order.table_id}
                  </Text>
                </View>
                <View
                  style={[
                    styles.elapsedPill,
                    isStale && styles.elapsedPillStale,
                  ]}
                >
                  <Text
                    style={[
                      styles.elapsedLabel,
                      isStale && styles.elapsedLabelStale,
                    ]}
                  >
                    {isStale ? "OVERDUE" : "Elapsed"}
                  </Text>
                  <Text
                    style={[
                      styles.elapsed,
                      isStale && styles.elapsedStale,
                    ]}
                  >
                    {formatElapsed(ageMs)}
                  </Text>
                </View>
              </View>

              <View style={styles.divider} />

              <Text style={styles.itemsHead}>Items</Text>
              <View style={styles.items}>
                {order.items.map((line: ActiveOrderItem) => {
                  const notes = (line.notes ?? "").trim();
                  const isReady = line.status === "ready";
                  const isServed = line.status === "served";
                  const done = isReady || isServed;
                  return (
                    <Pressable
                      key={line.id}
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: done,
                        disabled: isServed,
                      }}
                      onPress={() =>
                        toggleItemReady(order.id, line.id, line.status)
                      }
                      disabled={isServed}
                      style={({ pressed }) => [
                        styles.lineRow,
                        pressed && !isServed && styles.lineRowPressed,
                      ]}
                    >
                      <View
                        style={[
                          styles.checkbox,
                          done && styles.checkboxDone,
                        ]}
                      >
                        {done ? (
                          <Text style={styles.checkboxTick}>✓</Text>
                        ) : null}
                      </View>
                      <Text
                        style={[styles.lineQty, done && styles.lineDim]}
                      >
                        {line.quantity ?? 1}×
                      </Text>
                      <View style={styles.lineMain}>
                        <Text
                          numberOfLines={2}
                          style={[styles.line, done && styles.lineDone]}
                        >
                          {line.menu_item_name}
                        </Text>
                        {notes ? (
                          <Text
                            numberOfLines={2}
                            style={[
                              styles.lineNotes,
                              done && styles.lineDim,
                            ]}
                          >
                            {notes}
                          </Text>
                        ) : null}
                        {isReady ? (
                          <Text style={styles.lineStatusReady}>
                            Sent to runner
                          </Text>
                        ) : null}
                        {isServed ? (
                          <Text style={styles.lineStatusServed}>
                            Delivered
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles — warm "premium" palette, vertical list of ivory cards     */
/* ------------------------------------------------------------------ */

const STALE_CARD_BG = "#FEF2F2";
const STALE_BORDER = "#FCA5A5";
const STALE_ACCENT = "#B91C1C";

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: premium.screen },
  container: {
    padding: 20,
    paddingBottom: 40,
    gap: 16,
  },
  intro: { marginBottom: 4 },
  introKicker: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.kitchen,
    letterSpacing: 2.5,
    marginBottom: 6,
  },
  introTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.5,
  },
  introRule: {
    width: 40,
    height: 3,
    backgroundColor: premium.kitchen,
    marginTop: 10,
    marginBottom: 12,
    borderRadius: 2,
  },
  hint: { fontSize: 14, lineHeight: 21, color: premium.charcoalSoft },

  errorBanner: {
    backgroundColor: "#FEE2E2",
    borderRadius: 14,
    padding: 14,
    gap: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#FCA5A5",
  },
  errorText: { color: "#991B1B", fontSize: 13, textAlign: "center" },
  retryBtn: {
    backgroundColor: "#B91C1C",
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 999,
  },
  retryBtnText: { color: "#FFFFFF", fontWeight: "800", fontSize: 13 },

  empty: {
    paddingVertical: 44,
    paddingHorizontal: 24,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: premium.border,
    alignItems: "center",
  },
  emptyIcon: {
    fontSize: 28,
    color: premium.mutedLight,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: premium.charcoal,
    marginBottom: 4,
  },
  emptyText: { color: premium.muted, fontSize: 14, textAlign: "center" },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: premium.border,
    borderLeftWidth: 4,
    borderLeftColor: premium.kitchen,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  cardStale: {
    backgroundColor: STALE_CARD_BG,
    borderColor: STALE_BORDER,
    borderLeftColor: STALE_ACCENT,
  },
  cardPressed: { opacity: 0.96 },

  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  cardHeaderMain: { flex: 1, minWidth: 0 },
  tableLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.kitchen,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  tableLabelStale: { color: STALE_ACCENT },
  tableName: {
    fontSize: 34,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.8,
  },
  elapsedPill: {
    backgroundColor: premium.kitchenSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: "flex-end",
    minWidth: 84,
    borderWidth: 1,
    borderColor: premium.kitchenSoft,
  },
  elapsedPillStale: {
    backgroundColor: "#FEE2E2",
    borderColor: "#FCA5A5",
  },
  elapsedLabel: {
    fontSize: 9,
    fontWeight: "800",
    color: premium.kitchen,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  elapsedLabelStale: { color: STALE_ACCENT },
  elapsed: {
    fontSize: 18,
    fontWeight: "800",
    color: premium.kitchen,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.2,
  },
  elapsedStale: { color: STALE_ACCENT },

  divider: {
    height: 1,
    backgroundColor: premium.border,
    marginVertical: 14,
  },

  itemsHead: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.muted,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginTop: 14,
    marginBottom: 8,
  },
  items: { gap: 2 },
  lineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  lineRowPressed: { backgroundColor: "rgba(0, 0, 0, 0.04)" },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: premium.muted,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
    backgroundColor: "transparent",
  },
  checkboxDone: {
    backgroundColor: premium.runner,
    borderColor: premium.runner,
  },
  checkboxTick: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 16,
  },
  lineQty: {
    fontSize: 15,
    fontWeight: "800",
    color: premium.kitchen,
    minWidth: 30,
    marginTop: 1,
  },
  lineMain: { flex: 1, minWidth: 0 },
  line: {
    fontSize: 16,
    lineHeight: 22,
    color: premium.charcoal,
    fontWeight: "700",
  },
  lineDone: {
    textDecorationLine: "line-through",
    color: premium.muted,
    fontWeight: "600",
  },
  lineDim: { color: premium.mutedLight },
  lineNotes: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: premium.charcoalSoft,
    fontStyle: "italic",
  },
  lineStatusReady: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "800",
    color: premium.runner,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  lineStatusServed: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: "800",
    color: premium.mutedLight,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
});
