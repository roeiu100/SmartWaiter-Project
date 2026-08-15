import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MENU_API_BASE } from "../services/menuApi";
import {
  fetchUnpaidOrders,
  type ActiveOrder,
  type ActiveOrderItemStatus,
} from "../services/orderApi";
import { premium } from "../theme/premium";

/** No `tables` table exists in the DB — this is a fixed demo table set. */
const TABLE_IDS = ["1", "2", "3", "4", "5"];

function formatPlacedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Dish-level lifecycle shown in the Table Map modal. "Preparing"/"Ready"/
 * "Served" map directly onto `order_items.status` (`pending|ready|served`)
 * — the same column Kitchen/Runner already write to via `patchItemStatus`.
 * "Paid" is NOT a stored per-item value; it's derived client-side once the
 * order's `paid_at` is set (whole-table payment). See the explanation this
 * was delivered with for why that's the right split.
 */
type DishStatus = "preparing" | "ready" | "served" | "paid";

const DISH_STATUS_META: Record<
  DishStatus,
  { label: string; color: string; bg: string }
> = {
  preparing: { label: "Preparing", color: premium.kitchen, bg: premium.kitchenSoft },
  ready: { label: "Ready", color: premium.goldDark, bg: premium.goldMuted },
  served: { label: "Served", color: premium.runner, bg: premium.runnerSoft },
  paid: { label: "Paid", color: "#4338CA", bg: "rgba(99,102,241,0.14)" },
};

function getDishStatus(
  itemStatus: ActiveOrderItemStatus,
  isPaid: boolean
): DishStatus {
  if (isPaid) return "paid";
  if (itemStatus === "served") return "served";
  if (itemStatus === "ready") return "ready";
  return "preparing";
}

function DishBadge({ status }: { status: DishStatus }) {
  const meta = DISH_STATUS_META[status];
  return (
    <View style={[styles.dishBadge, { backgroundColor: meta.bg }]}>
      <Text style={[styles.dishBadgeText, { color: meta.color }]}>
        {meta.label}
      </Text>
    </View>
  );
}

/**
 * Zero-prop by design — reused as both a Manager Tab.Screen and a Runner
 * Stack.Screen, which have incompatible navigation prop shapes. See
 * KitchenDashboardScreen / RunnerDashboardScreen for the same pattern.
 */
export function TableMapScreen() {
  const insets = useSafeAreaInsets();
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  /**
   * A frozen copy of a table's orders taken the instant `table_paid` fires
   * for whichever table the modal currently has open. `/api/orders/unpaid`
   * excludes paid orders, so without this the modal would just go blank the
   * moment a guest pays — this snapshot is what lets staff actually see the
   * "Paid" badge as closure instead of the list vanishing under them.
   */
  const [justPaidSnapshot, setJustPaidSnapshot] = useState<{
    tableId: string;
    orders: ActiveOrder[];
  } | null>(null);

  // Refs so the mount-once socket listener always reads the latest
  // selection/data without reconnecting the socket on every state change.
  const selectedTableIdRef = useRef<string | null>(null);
  const ordersRef = useRef<ActiveOrder[]>([]);
  useEffect(() => {
    selectedTableIdRef.current = selectedTableId;
  }, [selectedTableId]);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const loadOrders = useCallback(async (opts?: { silent?: boolean }) => {
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
      const message = e instanceof Error ? e.message : "Could not load tables";
      if (silent) {
        console.warn("[TableMap] Silent refresh failed:", message);
      } else {
        setError(message);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    const baseUrl = (MENU_API_BASE ?? "").toString().trim();
    if (!baseUrl) return;
    const socket: Socket = io(baseUrl, { transports: ["websocket", "polling"] });
    const onChanged = () => void loadOrders({ silent: true });
    const onTablePaid = (payload: { table_id?: unknown }) => {
      const paidTableId =
        typeof payload?.table_id === "string" ? payload.table_id : null;
      if (paidTableId && selectedTableIdRef.current === paidTableId) {
        const frozen = ordersRef.current.filter(
          (o) => o.table_id === paidTableId
        );
        setJustPaidSnapshot({ tableId: paidTableId, orders: frozen });
      }
      void loadOrders({ silent: true });
    };
    socket.on("order_created", onChanged);
    socket.on("order_status_changed", onChanged);
    socket.on("order_item_status_changed", onChanged);
    socket.on("table_paid", onTablePaid);
    return () => {
      socket.off("order_created", onChanged);
      socket.off("order_status_changed", onChanged);
      socket.off("order_item_status_changed", onChanged);
      socket.off("table_paid", onTablePaid);
      socket.disconnect();
    };
  }, [loadOrders]);

  const ordersByTable = useMemo(() => {
    const m = new Map<string, ActiveOrder[]>();
    for (const o of orders) {
      const arr = m.get(o.table_id) ?? [];
      arr.push(o);
      m.set(o.table_id, arr);
    }
    return m;
  }, [orders]);

  const isJustPaidView =
    selectedTableId != null && justPaidSnapshot?.tableId === selectedTableId;
  const selectedOrders = isJustPaidView
    ? justPaidSnapshot!.orders
    : selectedTableId
      ? (ordersByTable.get(selectedTableId) ?? [])
      : [];
  const selectedTotal = selectedOrders.reduce(
    (sum, o) => sum + o.total_price,
    0
  );

  const closeModal = useCallback(() => {
    setSelectedTableId(null);
    setJustPaidSnapshot(null);
  }, []);

  const onPrintBill = useCallback(() => {
    console.log("[TableMap] Print bill stub", selectedTableId, selectedOrders);
    Alert.alert("Print Bill", "Printing is not yet implemented.");
  }, [selectedTableId, selectedOrders]);

  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top, 12) }]}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>FLOOR</Text>
        <Text style={styles.heroTitle}>Table Map</Text>
      </View>

      {loading ? (
        <View style={styles.loadingBanner}>
          <ActivityIndicator size="large" color={premium.gold} />
        </View>
      ) : error != null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void loadOrders()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={TABLE_IDS}
          keyExtractor={(id) => id}
          numColumns={3}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item: tableId }) => {
            const tableOrders = ordersByTable.get(tableId) ?? [];
            const occupied = tableOrders.length > 0;
            const total = tableOrders.reduce((sum, o) => sum + o.total_price, 0);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Table ${tableId}`}
                onPress={() => setSelectedTableId(tableId)}
                style={({ pressed }) => [
                  styles.tableCard,
                  occupied && styles.tableCardOccupied,
                  pressed && styles.tableCardPressed,
                ]}
              >
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: occupied ? premium.runner : premium.border },
                  ]}
                />
                <Text style={styles.tableLabel}>Table {tableId}</Text>
                <Text style={styles.tableMeta}>
                  {occupied
                    ? `${tableOrders.length} order${tableOrders.length === 1 ? "" : "s"}`
                    : "Empty"}
                </Text>
                {occupied ? (
                  <Text style={styles.tableTotal}>${total.toFixed(2)}</Text>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}

      <Modal
        visible={selectedTableId != null}
        transparent
        animationType="fade"
        onRequestClose={closeModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Table {selectedTableId}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={closeModal}
                hitSlop={8}
              >
                <Text style={styles.modalClose}>✕</Text>
              </Pressable>
            </View>

            {isJustPaidView ? (
              <View style={styles.paidBanner}>
                <Text style={styles.paidBannerText}>
                  ✓ Bill paid — table cleared for the next guest
                </Text>
              </View>
            ) : null}

            {selectedOrders.length === 0 ? (
              <Text style={styles.modalEmpty}>No active orders for this table.</Text>
            ) : (
              <FlatList
                data={selectedOrders}
                keyExtractor={(o) => o.id}
                style={styles.modalList}
                renderItem={({ item }) => (
                  <View style={styles.modalOrderCard}>
                    <View style={styles.modalOrderHeader}>
                      <Text style={styles.modalPlacedAt}>
                        Placed at {formatPlacedAt(item.created_at)}
                      </Text>
                      <Text style={styles.modalStatus}>{item.status}</Text>
                    </View>
                    {item.items.map((line) => (
                      <View key={line.id} style={styles.modalItemRow}>
                        <View style={styles.modalItemTextCol}>
                          <Text style={styles.modalItemLine} numberOfLines={2}>
                            {line.quantity} × {line.menu_item_name}
                          </Text>
                          <DishBadge
                            status={getDishStatus(line.status, isJustPaidView)}
                          />
                        </View>
                        <Text style={styles.modalItemPrice}>
                          ${(line.unit_price * line.quantity).toFixed(2)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              />
            )}

            <View style={styles.modalFooter}>
              <View>
                <Text style={styles.modalTotalLabel}>Total</Text>
                <Text style={styles.modalTotal}>${selectedTotal.toFixed(2)}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Print Bill"
                onPress={onPrintBill}
                style={({ pressed }) => [
                  styles.printBtn,
                  pressed && styles.printBtnPressed,
                ]}
              >
                <Text style={styles.printBtnText}>Print Bill</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: premium.screen },
  hero: { paddingHorizontal: 20, paddingBottom: 16 },
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
  loadingBanner: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorBanner: {
    flex: 1,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  errorText: { fontSize: 15, color: "#DC2626", textAlign: "center" },
  retryBtn: {
    backgroundColor: premium.goldDark,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  retryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },

  grid: { paddingHorizontal: 16, paddingBottom: 24, gap: 14 },
  gridRow: { gap: 14 },
  tableCard: {
    flex: 1,
    backgroundColor: premium.ivory,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: premium.border,
    paddingVertical: 20,
    paddingHorizontal: 12,
    alignItems: "center",
    gap: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  tableCardOccupied: { borderColor: premium.runner, borderWidth: 1.5 },
  tableCardPressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginBottom: 4 },
  tableLabel: { fontSize: 17, fontWeight: "800", color: premium.charcoal },
  tableMeta: { fontSize: 12, color: premium.muted, fontWeight: "600" },
  tableTotal: { fontSize: 14, fontWeight: "800", color: premium.goldDark },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: premium.ivory,
    borderRadius: 20,
    padding: 20,
    maxHeight: "80%",
    gap: 14,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.4,
  },
  modalClose: { fontSize: 18, color: premium.muted, fontWeight: "700" },
  modalEmpty: { fontSize: 15, color: premium.muted, paddingVertical: 12 },
  modalList: { maxHeight: 360 },
  modalOrderCard: {
    backgroundColor: premium.ivoryDark,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: premium.border,
    padding: 14,
    marginBottom: 10,
    gap: 8,
  },
  modalOrderHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  modalPlacedAt: { fontSize: 12, fontWeight: "700", color: premium.muted },
  modalStatus: {
    fontSize: 11,
    fontWeight: "700",
    color: premium.goldDark,
    textTransform: "uppercase",
  },
  modalItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  modalItemTextCol: { flex: 1, gap: 5 },
  modalItemLine: { fontSize: 14, color: premium.charcoalSoft },
  modalItemPrice: { fontSize: 14, fontWeight: "700", color: premium.charcoal },
  dishBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 8,
  },
  dishBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  paidBanner: {
    backgroundColor: "rgba(99,102,241,0.14)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  paidBannerText: { color: "#4338CA", fontWeight: "700", fontSize: 13 },

  modalFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: premium.border,
    paddingTop: 14,
  },
  modalTotalLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: premium.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  modalTotal: { fontSize: 24, fontWeight: "800", color: premium.goldDark },
  printBtn: {
    backgroundColor: premium.navBar,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  printBtnPressed: { opacity: 0.85 },
  printBtnText: { color: premium.navAccent, fontWeight: "700", fontSize: 14 },
});
