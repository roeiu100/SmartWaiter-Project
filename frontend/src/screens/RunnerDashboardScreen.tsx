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

type Props = NativeStackScreenProps<RootStackParamList, "Runner">;

interface RunnerAlert {
  id: number;
  table: string;
  request: string;
  time: string;
}

const RUNNER_SOCKET_URL = (MENU_API_BASE ?? "").toString().trim();

function formatAlertElapsed(iso: string, now: number): string {
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s ago`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s ago`;
}

function parseRunnerAlert(data: unknown): RunnerAlert | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as {
    id?: unknown;
    table?: unknown;
    request?: unknown;
    time?: unknown;
  };
  const idNum =
    typeof raw.id === "number"
      ? raw.id
      : typeof raw.id === "string" && raw.id !== ""
        ? Number(raw.id)
        : NaN;
  if (!Number.isFinite(idNum)) return null;
  const table =
    typeof raw.table === "string" ? raw.table : String(raw.table ?? "");
  if (!table) return null;
  const request = typeof raw.request === "string" ? raw.request : "";
  const time =
    typeof raw.time === "string" ? raw.time : new Date().toISOString();
  return { id: idNum, table, request, time };
}

/** Orders that have at least one "ready" item waiting to be delivered. */
function getRunnerQueue(orders: ActiveOrder[]): ActiveOrder[] {
  return orders
    .filter(
      (o) =>
        o.status !== "delivered" &&
        o.items.some((it) => it.status === "ready")
    )
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function RunnerDashboardScreen(_props: Props) {
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runnerAlerts, setRunnerAlerts] = useState<RunnerAlert[]>([]);
  const socketRef = useRef<Socket | null>(null);

  const ready = useMemo(() => getRunnerQueue(orders), [orders]);

  const reload = useCallback(async () => {
    try {
      const list = await fetchActiveOrders();
      setOrders(list);
      setLoadError(null);
    } catch (err) {
      console.warn("[Runner] fetchActiveOrders failed:", err);
      setLoadError(err instanceof Error ? err.message : "Could not load orders");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Tick for live "elapsed" labels.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!RUNNER_SOCKET_URL) {
      console.warn("[Runner] MENU_API_BASE is not set; sockets disabled");
      return;
    }
    const s = io(RUNNER_SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
    });
    socketRef.current = s;

    const onConnect = () => {
      console.log("[Runner] socket connected:", s.id);
      s.emit("get_runner_alerts");
      void reload();
    };
    const onConnectError = (err: Error) => {
      console.warn("[Runner] socket connect_error:", err?.message ?? err);
    };
    const onNewRunnerAlert = (data: unknown) => {
      const alert = parseRunnerAlert(data);
      if (!alert) return;
      setRunnerAlerts((prev) =>
        prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]
      );
    };
    const onSyncRunnerAlerts = (payload: unknown) => {
      const list = Array.isArray(payload)
        ? (payload
            .map(parseRunnerAlert)
            .filter(Boolean) as RunnerAlert[])
        : [];
      list.sort((a, b) => b.id - a.id);
      setRunnerAlerts(list);
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
    s.on("new_runner_alert", onNewRunnerAlert);
    s.on("sync_runner_alerts", onSyncRunnerAlerts);
    s.on("order_created", onOrderCreated);
    s.on("order_item_status_changed", onItemStatusChanged);
    s.on("order_status_changed", onOrderStatusChanged);

    if (s.connected) s.emit("get_runner_alerts");

    return () => {
      s.off("connect", onConnect);
      s.off("connect_error", onConnectError);
      s.off("new_runner_alert", onNewRunnerAlert);
      s.off("sync_runner_alerts", onSyncRunnerAlerts);
      s.off("order_created", onOrderCreated);
      s.off("order_item_status_changed", onItemStatusChanged);
      s.off("order_status_changed", onOrderStatusChanged);
      s.disconnect();
      if (socketRef.current === s) socketRef.current = null;
    };
  }, [reload]);

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
        console.warn("[Runner] patchItemStatus failed:", err);
        setOrders(snapshot);
        Alert.alert(
          "Could not update",
          err instanceof Error ? err.message : "Server rejected the update"
        );
      }
    },
    [orders]
  );

  const onServeItem = useCallback(
    (orderId: string, itemId: string) => {
      void flipItemStatus(orderId, itemId, "served");
    },
    [flipItemStatus]
  );

  const onServeAll = useCallback(
    async (order: ActiveOrder) => {
      for (const line of order.items) {
        if (line.status === "ready") {
          await flipItemStatus(order.id, line.id, "served");
        }
      }
    },
    [flipItemStatus]
  );

  const onMarkRequestComplete = useCallback((alertId: number) => {
    setRunnerAlerts((prev) => prev.filter((a) => a.id !== alertId));
    socketRef.current?.emit("clear_runner_alert", { id: alertId });
  }, []);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      <View style={styles.intro}>
        <Text style={styles.introKicker}>SERVICE</Text>
        <Text style={styles.introTitle}>Ready to deliver</Text>
        <View style={styles.introRule} />
        <Text style={styles.hint}>
          Tap a dish to mark it delivered. Table requests (ketchup, water,
          etc.) appear at the top — clear them when you've brought them
          out.
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

      {runnerAlerts.length > 0 ? (
        <View style={styles.requestsSection}>
          <Text style={styles.requestsHead}>
            Table requests ({runnerAlerts.length})
          </Text>
          <View style={styles.requestsGrid}>
            {runnerAlerts.map((alert) => (
              <View key={alert.id} style={styles.requestCard}>
                <View style={styles.requestHeader}>
                  <View style={styles.requestHeaderMain}>
                    <Text style={styles.requestIcon}>🛎</Text>
                    <View style={styles.requestHeaderText}>
                      <Text style={styles.requestLabel}>Request</Text>
                      <Text style={styles.requestTable} numberOfLines={1}>
                        Table {alert.table}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.requestElapsed}>
                    {formatAlertElapsed(alert.time, now)}
                  </Text>
                </View>

                <Text style={styles.requestBody} numberOfLines={3}>
                  {alert.request || "(no details)"}
                </Text>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Mark request for table ${alert.table} complete`}
                  onPress={() => onMarkRequestComplete(alert.id)}
                  style={({ pressed }) => [
                    styles.requestBtn,
                    pressed && styles.requestBtnPressed,
                  ]}
                >
                  <Text style={styles.requestBtnLabel}>Mark Complete</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {ready.length === 0 && runnerAlerts.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>◎</Text>
          <Text style={styles.emptyTitle}>No deliveries</Text>
          <Text style={styles.emptyText}>
            Items and requests appear here when the kitchen or guests need
            service
          </Text>
        </View>
      ) : ready.length === 0 ? null : (
        ready.map((order) => {
          const readyItems = order.items.filter(
            (it: ActiveOrderItem) => it.status === "ready"
          );
          const servedItems = order.items.filter(
            (it: ActiveOrderItem) => it.status === "served"
          );
          const stillCooking = order.items.filter(
            (it: ActiveOrderItem) => it.status === "pending"
          ).length;
          return (
            <View key={order.id} style={styles.card}>
              <View style={styles.readyPill}>
                <Text style={styles.readyPillText}>
                  {readyItems.length} ready
                </Text>
              </View>

              <Text style={styles.deliverLabel}>Deliver to</Text>
              <Text style={styles.table}>{order.table_id}</Text>

              <View style={styles.divider} />

              <Text style={styles.itemsHead}>Ready now</Text>
              <View style={styles.items}>
                {readyItems.map((line) => (
                  <Pressable
                    key={line.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark ${line.menu_item_name} delivered`}
                    onPress={() => onServeItem(order.id, line.id)}
                    style={({ pressed }) => [
                      styles.lineRow,
                      pressed && styles.lineRowPressed,
                    ]}
                  >
                    <View style={styles.checkbox} />
                    <Text style={styles.lineQty}>{line.quantity ?? 1}×</Text>
                    <Text style={styles.line}>{line.menu_item_name}</Text>
                  </Pressable>
                ))}
              </View>

              {servedItems.length > 0 ? (
                <>
                  <Text style={styles.subHead}>Already delivered</Text>
                  <View style={styles.items}>
                    {servedItems.map((line) => (
                      <View key={line.id} style={styles.lineRow}>
                        <View style={[styles.checkbox, styles.checkboxDone]}>
                          <Text style={styles.checkboxTick}>✓</Text>
                        </View>
                        <Text style={[styles.lineQty, styles.lineDim]}>
                          {line.quantity ?? 1}×
                        </Text>
                        <Text style={[styles.line, styles.lineDone]}>
                          {line.menu_item_name}
                        </Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}

              {stillCooking > 0 ? (
                <Text style={styles.cookingNote}>
                  {stillCooking} more {stillCooking === 1 ? "dish" : "dishes"}{" "}
                  still cooking
                </Text>
              ) : null}

              {readyItems.length > 1 ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.servedBtn,
                    pressed && styles.servedBtnPressed,
                  ]}
                  onPress={() => void onServeAll(order)}
                >
                  <Text style={styles.servedBtnText}>
                    Mark all {readyItems.length} delivered
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingBottom: 40,
    gap: 16,
    backgroundColor: premium.screen,
  },
  intro: { marginBottom: 8 },
  introKicker: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.goldDark,
    letterSpacing: 2,
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
    backgroundColor: premium.gold,
    marginTop: 10,
    marginBottom: 12,
    borderRadius: 2,
  },
  hint: { fontSize: 14, lineHeight: 21, color: premium.charcoalSoft },
  errorBanner: {
    backgroundColor: "#FEE2E2",
    borderRadius: 12,
    padding: 14,
    gap: 10,
    alignItems: "center",
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
    backgroundColor: premium.ivory,
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
    padding: 22,
    borderWidth: 1,
    borderColor: premium.border,
    borderLeftWidth: 4,
    borderLeftColor: premium.runner,
    position: "relative",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  readyPill: {
    position: "absolute",
    top: 18,
    right: 18,
    backgroundColor: premium.runner,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  readyPillText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  deliverLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.runner,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
    marginTop: 4,
  },
  table: {
    fontSize: 42,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -1,
  },
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
    marginTop: 12,
    marginBottom: 10,
  },
  subHead: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.mutedLight,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginTop: 14,
    marginBottom: 8,
  },
  items: { gap: 6 },
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  lineRowPressed: {
    backgroundColor: "rgba(0, 0, 0, 0.04)",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: premium.runner,
    alignItems: "center",
    justifyContent: "center",
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
    color: premium.runner,
    minWidth: 28,
  },
  line: {
    flex: 1,
    fontSize: 16,
    lineHeight: 23,
    color: premium.charcoal,
    fontWeight: "600",
  },
  lineDone: {
    textDecorationLine: "line-through",
    color: premium.muted,
  },
  lineDim: {
    color: premium.mutedLight,
  },
  cookingNote: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: "600",
    color: premium.charcoalSoft,
    fontStyle: "italic",
  },
  servedBtn: {
    marginTop: 18,
    backgroundColor: premium.runner,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  servedBtnPressed: { opacity: 0.92 },
  servedBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
  },
  requestsSection: {
    gap: 10,
  },
  requestsHead: {
    fontSize: 11,
    fontWeight: "800",
    color: "#1D4ED8",
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  requestsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  requestCard: {
    width: "100%",
    minHeight: 140,
    backgroundColor: "#EFF6FF",
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 4,
  },
  requestHeader: {
    backgroundColor: "#1D4ED8",
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  requestHeaderMain: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
    gap: 10,
  },
  requestHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  requestIcon: {
    fontSize: 20,
    lineHeight: 22,
  },
  requestLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "rgba(255, 255, 255, 0.72)",
    textTransform: "uppercase",
    letterSpacing: 1.5,
  },
  requestTable: {
    fontSize: 18,
    fontWeight: "800",
    color: "#FFFFFF",
    letterSpacing: -0.2,
    marginTop: 1,
  },
  requestElapsed: {
    fontSize: 11,
    fontWeight: "800",
    color: "rgba(255, 255, 255, 0.92)",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  requestBody: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
    fontSize: 15,
    lineHeight: 21,
    color: "#0F172A",
    fontWeight: "600",
  },
  requestBtn: {
    marginHorizontal: 14,
    marginBottom: 14,
    backgroundColor: "#2563EB",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  requestBtnPressed: {
    opacity: 0.88,
  },
  requestBtnLabel: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
});
