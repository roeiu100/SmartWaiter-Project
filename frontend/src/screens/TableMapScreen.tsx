import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import Svg, { Circle, Rect } from "react-native-svg";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  type LayoutChangeEvent,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MENU_API_BASE } from "../services/menuApi";
import {
  cancelOrderItem,
  fetchUnpaidOrders,
  resolveCancellationRequest,
  type ActiveOrder,
  type ActiveOrderItem,
  type ActiveOrderItemStatus,
} from "../services/orderApi";
import { TABLE_LAYOUT, type TableLayoutEntry, type TableShape } from "../data/tableLayout";
import { useAuthStore } from "../store/authStore";
import { usePendingCancellationsStore } from "../store/pendingCancellationsStore";
import { premium } from "../theme/premium";

const CHAIR_SIZE = 10;
const CHAIR_GAP = 6;

// Warm wood palette for the floor + tabletops, and a chair-frame tone —
// deliberately NOT tied to `premium` (which is a neutral gray/gold UI
// palette) since the floor plan should read as an actual restaurant room.
const WOOD_PLANK_SHADES = ["#C9975C", "#BE8A4E", "#B47F45", "#A8763E"];
const WOOD_PLANK_SEPARATOR = "rgba(74,46,20,0.35)";
const WOOD_PLANK_GRAIN = "rgba(255,255,255,0.10)";
const PLANK_WIDTH = 46;

const WOOD_TABLE_FILL = "#DCA972";
const WOOD_TABLE_EDGE = "#8B5A2B";
const CHAIR_COLOR = "#5C3A21";

const STATUS_COLORS = {
  empty: { ring: "#22C55E", chipBg: "rgba(34,197,94,0.16)", chipText: "#15803D" },
  occupied: { ring: "#F97316", chipBg: "rgba(249,115,22,0.18)", chipText: "#C2410C" },
};

/** A full-bleed wood-plank floor texture, purely SVG (no image assets). */
function WoodFloorBackground({ width, height }: { width: number; height: number }) {
  const plankCount = useMemo(
    () => (width > 0 ? Math.ceil(width / PLANK_WIDTH) + 1 : 0),
    [width]
  );
  if (width <= 0 || height <= 0 || plankCount === 0) return null;
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <Svg width={width} height={height}>
        {Array.from({ length: plankCount }, (_, i) => {
          const x = i * PLANK_WIDTH;
          const shade = WOOD_PLANK_SHADES[i % WOOD_PLANK_SHADES.length];
          return (
            <Fragment key={i}>
              <Rect x={x} y={0} width={PLANK_WIDTH} height={height} fill={shade} />
              <Rect x={x + PLANK_WIDTH * 0.28} y={height * 0.18} width={PLANK_WIDTH * 0.44} height={1.5} fill={WOOD_PLANK_GRAIN} />
              <Rect x={x + PLANK_WIDTH * 0.18} y={height * 0.52} width={PLANK_WIDTH * 0.5} height={1.5} fill={WOOD_PLANK_GRAIN} />
              <Rect x={x + PLANK_WIDTH * 0.32} y={height * 0.8} width={PLANK_WIDTH * 0.36} height={1.5} fill={WOOD_PLANK_GRAIN} />
              <Rect x={x - 0.75} y={0} width={1.5} height={height} fill={WOOD_PLANK_SEPARATOR} />
            </Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

interface ChairSpec {
  seatX: number;
  seatY: number;
  backX: number;
  backY: number;
}

/**
 * Seat + backrest position for each chair, in SVG units local to the
 * table's center. The backrest sits further from center than the seat
 * along the same direction, so every chair visually "faces" the table
 * with no rotation math needed.
 */
function getChairSpecs(
  shape: TableShape,
  seats: number,
  tableW: number,
  tableH: number
): ChairSpec[] {
  const n = Math.max(1, seats);
  const specs: ChairSpec[] = [];
  if (shape === "round") {
    const seatRadius = tableW / 2 + CHAIR_GAP + CHAIR_SIZE / 2;
    const backRadius = seatRadius + CHAIR_SIZE * 0.6;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      specs.push({
        seatX: cosA * seatRadius,
        seatY: sinA * seatRadius,
        backX: cosA * backRadius,
        backY: sinA * backRadius,
      });
    }
    return specs;
  }
  // Rectangular table: distribute seats along the two long (top/bottom) edges.
  const topCount = Math.ceil(n / 2);
  const bottomCount = n - topCount;
  const seatOffsetY = tableH / 2 + CHAIR_GAP + CHAIR_SIZE / 2;
  const backOffsetY = seatOffsetY + CHAIR_SIZE * 0.6;
  const spread = (count: number, seatY: number, backY: number) => {
    if (count === 0) return;
    const usableWidth = tableW * 0.8;
    const step = count > 1 ? usableWidth / (count - 1) : 0;
    const startX = count > 1 ? -usableWidth / 2 : 0;
    for (let i = 0; i < count; i++) {
      const x = count > 1 ? startX + step * i : 0;
      specs.push({ seatX: x, seatY, backX: x, backY });
    }
  };
  spread(topCount, -seatOffsetY, -backOffsetY);
  spread(bottomCount, seatOffsetY, backOffsetY);
  return specs;
}

/**
 * One table on the floor plan: a wood tabletop (with a darker edge for
 * depth) surrounded by chair-shaped marks (seat + backrest), positioned
 * absolutely within the floor-plan canvas from the table's normalized
 * (0–1) x/y. Rotation is applied only to the tabletop+number group, not
 * the status chip/total below, so those stay readable regardless of angle.
 */
function FloorPlanTable({
  entry,
  occupied,
  orderCount,
  total,
  canvasWidth,
  canvasHeight,
  onPress,
}: {
  entry: TableLayoutEntry;
  occupied: boolean;
  orderCount: number;
  total: number;
  canvasWidth: number;
  canvasHeight: number;
  onPress: () => void;
}) {
  const shape: TableShape = entry.shape ?? "rect";
  const seats = entry.seats ?? 4;
  const tableW = 46 + seats * 6;
  const tableH = shape === "round" ? tableW : Math.round(tableW * 0.62);
  const chairSpecs = getChairSpecs(shape, seats, tableW, tableH);
  const padding = CHAIR_SIZE + CHAIR_GAP + 8;
  const svgW = tableW + padding * 2;
  const svgH = tableH + padding * 2;
  const cx = svgW / 2;
  const cy = svgH / 2;
  const status = occupied ? STATUS_COLORS.occupied : STATUS_COLORS.empty;
  const numberFontSize = Math.max(20, Math.round(tableW * 0.3));

  const left = entry.x * canvasWidth - svgW / 2;
  const top = entry.y * canvasHeight - svgH / 2;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Table ${entry.id}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.floorTableWrap,
        { left, top, width: svgW },
        pressed && styles.tableCardPressed,
      ]}
    >
      <View style={[styles.tableShadow, { transform: [{ rotate: `${entry.rotation ?? 0}deg` }] }]}>
        <Svg width={svgW} height={svgH}>
          {chairSpecs.map((c, i) => (
            <Fragment key={i}>
              <Rect
                x={cx + c.backX - CHAIR_SIZE / 2}
                y={cy + c.backY - 3}
                width={CHAIR_SIZE}
                height={6}
                rx={2}
                fill={CHAIR_COLOR}
              />
              <Rect
                x={cx + c.seatX - CHAIR_SIZE / 2}
                y={cy + c.seatY - CHAIR_SIZE / 2}
                width={CHAIR_SIZE}
                height={CHAIR_SIZE}
                rx={3}
                fill={CHAIR_COLOR}
              />
            </Fragment>
          ))}
          {shape === "round" ? (
            <>
              <Circle cx={cx} cy={cy} r={tableW / 2} fill={WOOD_TABLE_EDGE} />
              <Circle
                cx={cx}
                cy={cy}
                r={tableW / 2 - 3}
                fill={WOOD_TABLE_FILL}
                stroke={status.ring}
                strokeWidth={3.5}
              />
            </>
          ) : (
            <>
              <Rect
                x={cx - tableW / 2}
                y={cy - tableH / 2}
                width={tableW}
                height={tableH}
                rx={12}
                fill={WOOD_TABLE_EDGE}
              />
              <Rect
                x={cx - tableW / 2 + 3}
                y={cy - tableH / 2 + 3}
                width={tableW - 6}
                height={tableH - 6}
                rx={9}
                fill={WOOD_TABLE_FILL}
                stroke={status.ring}
                strokeWidth={3.5}
              />
            </>
          )}
        </Svg>
        <View style={styles.floorTableNumberWrap} pointerEvents="none">
          <Text style={[styles.floorTableNumber, { fontSize: numberFontSize }]}>
            {entry.id}
          </Text>
        </View>
      </View>
      <View style={styles.floorTableLabelWrap} pointerEvents="none">
        <View style={[styles.statusChip, { backgroundColor: status.chipBg }]}>
          <Text style={[styles.statusChipText, { color: status.chipText }]}>
            {occupied ? "Occupied" : "Empty"}
          </Text>
        </View>
        {occupied ? <Text style={styles.floorTableTotal}>${total.toFixed(2)}</Text> : null}
      </View>
    </Pressable>
  );
}

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
type DishStatus = "preparing" | "ready" | "served" | "paid" | "canceled";

const DISH_STATUS_META: Record<
  DishStatus,
  { label: string; color: string; bg: string }
> = {
  preparing: { label: "Preparing", color: premium.kitchen, bg: premium.kitchenSoft },
  ready: { label: "Ready", color: premium.goldDark, bg: premium.goldMuted },
  served: { label: "Served", color: premium.runner, bg: premium.runnerSoft },
  paid: { label: "Paid", color: "#4338CA", bg: "rgba(99,102,241,0.14)" },
  canceled: { label: "Canceled", color: "#6B7280", bg: "rgba(107,114,128,0.14)" },
};

function getDishStatus(
  itemStatus: ActiveOrderItemStatus,
  isPaid: boolean
): DishStatus {
  if (itemStatus === "canceled") return "canceled";
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
  // Cancel/approve controls are manager-only — Runner reaches this same
  // screen from RunnerStackNavigator and must not see them.
  const isManager = useAuthStore((s) => s.role) === "manager";
  const pendingCancellations = usePendingCancellationsStore((s) => s.items);
  const removePendingCancellation = usePendingCancellationsStore(
    (s) => s.removeItem
  );
  const [resolvingItemId, setResolvingItemId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{
    orderId: string;
    itemId: string;
    itemName: string;
  } | null>(null);
  const [cancelReasonText, setCancelReasonText] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCanvasSize({ width, height });
  }, []);
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
    socket.on("order_item_cancellation_requested", onChanged);
    socket.on("order_item_cancellation_resolved", onChanged);
    socket.on("table_paid", onTablePaid);
    return () => {
      socket.off("order_created", onChanged);
      socket.off("order_status_changed", onChanged);
      socket.off("order_item_status_changed", onChanged);
      socket.off("order_item_cancellation_requested", onChanged);
      socket.off("order_item_cancellation_resolved", onChanged);
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

  const openCancelPrompt = useCallback((orderId: string, item: ActiveOrderItem) => {
    setCancelTarget({ orderId, itemId: item.id, itemName: item.menu_item_name });
    setCancelReasonText("");
  }, []);

  const closeCancelPrompt = useCallback(() => {
    if (cancelSubmitting) return;
    setCancelTarget(null);
    setCancelReasonText("");
  }, [cancelSubmitting]);

  const confirmCancelItem = useCallback(async () => {
    if (!cancelTarget) return;
    const reason = cancelReasonText.trim();
    if (!reason) {
      Alert.alert("Reason required", "Please enter a reason for the cancellation.");
      return;
    }
    setCancelSubmitting(true);
    try {
      await cancelOrderItem(cancelTarget.orderId, cancelTarget.itemId, reason);
      setCancelTarget(null);
      setCancelReasonText("");
      void loadOrders({ silent: true });
    } catch (err) {
      console.error("[TableMap] cancelOrderItem failed:", err);
      Alert.alert(
        "Could not cancel item",
        err instanceof Error ? err.message : "Please try again."
      );
    } finally {
      setCancelSubmitting(false);
    }
  }, [cancelTarget, cancelReasonText, loadOrders]);

  const resolveRequest = useCallback(
    async (orderId: string, itemId: string, decision: "approve" | "reject") => {
      setResolvingItemId(itemId);
      try {
        await resolveCancellationRequest(orderId, itemId, decision);
        removePendingCancellation(itemId);
        void loadOrders({ silent: true });
      } catch (err) {
        console.error(
          `[TableMap] resolveCancellationRequest (${decision}) failed:`,
          err
        );
        Alert.alert(
          decision === "approve" ? "Could not approve" : "Could not reject",
          err instanceof Error ? err.message : "Please try again."
        );
      } finally {
        setResolvingItemId(null);
      }
    },
    [loadOrders, removePendingCancellation]
  );

  // The reason prompt is rendered as an overlay INSIDE the table-detail
  // Modal below (not as its own separate <Modal>). Two RN <Modal>s mounted
  // at once is an unsupported pattern — each Modal opens its own native
  // window, and stacking a second one on top of the first breaks the touch
  // responder chain (especially on Android): taps inside the top modal can
  // get lost, and once it closes the screen behind it stops receiving
  // touches at all. A single Modal with an internal overlay avoids that
  // entirely while looking identical.
  const onRequestCloseTableModal = useCallback(() => {
    if (cancelTarget) {
      closeCancelPrompt();
      return;
    }
    closeModal();
  }, [cancelTarget, closeCancelPrompt, closeModal]);

  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top, 12) }]}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>FLOOR</Text>
        <Text style={styles.heroTitle}>Table Map</Text>
      </View>

      {isManager && pendingCancellations.length > 0 ? (
        <View style={styles.pendingSection}>
          <Text style={styles.pendingSectionTitle}>
            Pending Cancellation Requests ({pendingCancellations.length})
          </Text>
          {pendingCancellations.map((req) => (
            <View key={req.item_id} style={styles.pendingCard}>
              <View style={styles.pendingCardText}>
                <Text style={styles.pendingCardTitle}>
                  Table {req.table_id} · {req.quantity} × {req.menu_item_name}
                </Text>
                {req.reason ? (
                  <Text style={styles.pendingCardReason}>"{req.reason}"</Text>
                ) : null}
              </View>
              <View style={styles.pendingCardActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Reject cancellation of ${req.menu_item_name}`}
                  disabled={resolvingItemId === req.item_id}
                  onPress={() => void resolveRequest(req.order_id, req.item_id, "reject")}
                  style={({ pressed }) => [
                    styles.pendingRejectBtn,
                    pressed && styles.pendingBtnPressed,
                  ]}
                >
                  <Text style={styles.pendingRejectBtnText}>Reject</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Approve cancellation of ${req.menu_item_name}`}
                  disabled={resolvingItemId === req.item_id}
                  onPress={() => void resolveRequest(req.order_id, req.item_id, "approve")}
                  style={({ pressed }) => [
                    styles.pendingApproveBtn,
                    pressed && styles.pendingBtnPressed,
                  ]}
                >
                  <Text style={styles.pendingApproveBtnText}>Approve</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}

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
        <View style={styles.floorPlanOuter} onLayout={onCanvasLayout}>
          <WoodFloorBackground width={canvasSize.width} height={canvasSize.height} />
          {canvasSize.width > 0
            ? TABLE_LAYOUT.map((entry) => {
                const tableOrders = ordersByTable.get(entry.id) ?? [];
                const occupied = tableOrders.length > 0;
                const total = tableOrders.reduce(
                  (sum, o) => sum + o.total_price,
                  0
                );
                return (
                  <FloorPlanTable
                    key={entry.id}
                    entry={entry}
                    occupied={occupied}
                    orderCount={tableOrders.length}
                    total={total}
                    canvasWidth={canvasSize.width}
                    canvasHeight={canvasSize.height}
                    onPress={() => setSelectedTableId(entry.id)}
                  />
                );
              })
            : null}
        </View>
      )}

      <Modal
        visible={selectedTableId != null}
        transparent
        animationType="fade"
        onRequestClose={onRequestCloseTableModal}
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
                    {item.items.map((line) => {
                      const isCanceled = line.status === "canceled";
                      const isPendingCancellation =
                        line.cancellation_status === "requested";
                      return (
                        <View key={line.id} style={styles.modalItemRow}>
                          <View style={styles.modalItemTextCol}>
                            <Text
                              style={[
                                styles.modalItemLine,
                                isCanceled && styles.modalItemLineCanceled,
                              ]}
                              numberOfLines={2}
                            >
                              {line.quantity} × {line.menu_item_name}
                            </Text>
                            <DishBadge
                              status={getDishStatus(line.status, isJustPaidView)}
                            />
                            {isCanceled && line.cancellation_reason ? (
                              <Text style={styles.modalCancelReason}>
                                Reason: {line.cancellation_reason}
                                {line.canceled_by === "ai_waiter"
                                  ? " (requested via AI waiter)"
                                  : ""}
                              </Text>
                            ) : null}
                            {isPendingCancellation ? (
                              <Text style={styles.modalCancelPending}>
                                Cancellation requested — awaiting your review above
                              </Text>
                            ) : null}
                          </View>
                          <View style={styles.modalItemRightCol}>
                            <Text
                              style={[
                                styles.modalItemPrice,
                                isCanceled && styles.modalItemLineCanceled,
                              ]}
                            >
                              ${(line.unit_price * line.quantity).toFixed(2)}
                            </Text>
                            {isManager && !isCanceled && !isJustPaidView ? (
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Cancel ${line.menu_item_name}`}
                                onPress={() => openCancelPrompt(item.id, line)}
                                style={({ pressed }) => [
                                  styles.cancelItemBtn,
                                  pressed && styles.cancelItemBtnPressed,
                                ]}
                              >
                                <Text style={styles.cancelItemBtnText}>Cancel</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
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

          {/* Reason prompt as an overlay INSIDE this same Modal — see
              onRequestCloseTableModal comment above for why this must not
              be a second <Modal>. */}
          {cancelTarget != null ? (
            <View style={styles.reasonOverlayBackdrop}>
              <View style={styles.reasonModalCard}>
                <Text style={styles.reasonModalTitle}>
                  Cancel {cancelTarget.itemName}
                </Text>
                <Text style={styles.reasonModalSubtitle}>
                  This takes effect immediately. Please enter a reason.
                </Text>
                <TextInput
                  value={cancelReasonText}
                  onChangeText={setCancelReasonText}
                  placeholder="e.g. Guest changed their mind"
                  placeholderTextColor={premium.mutedLight}
                  style={styles.reasonModalInput}
                  multiline
                  editable={!cancelSubmitting}
                />
                <View style={styles.reasonModalActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss without canceling"
                    disabled={cancelSubmitting}
                    onPress={closeCancelPrompt}
                    style={({ pressed }) => [
                      styles.reasonModalCancelBtn,
                      pressed && styles.pendingBtnPressed,
                    ]}
                  >
                    <Text style={styles.reasonModalCancelBtnText}>Dismiss</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Confirm item cancellation"
                    disabled={cancelSubmitting}
                    onPress={() => void confirmCancelItem()}
                    style={({ pressed }) => [
                      styles.reasonModalConfirmBtn,
                      pressed && styles.pendingBtnPressed,
                    ]}
                  >
                    <Text style={styles.reasonModalConfirmBtnText}>
                      {cancelSubmitting ? "Canceling…" : "Cancel Item"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : null}
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

  tableCardPressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },

  // Floor plan — a fixed-aspect "room" canvas that tables are absolutely
  // positioned within, via normalized (0-1) coordinates scaled to its
  // measured pixel size. Capped max width keeps it from stretching too
  // wide on large iPads; aspectRatio keeps it responsive at any width.
  floorPlanOuter: {
    marginHorizontal: 16,
    marginBottom: 24,
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    aspectRatio: 1.35,
    backgroundColor: "#B9814A",
    borderRadius: 20,
    borderWidth: 4,
    borderColor: "#6B4423",
    position: "relative",
    overflow: "hidden",
  },
  floorTableWrap: {
    position: "absolute",
    alignItems: "center",
  },
  tableShadow: {
    shadowColor: "#3D2410",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
    elevation: 6,
  },
  floorTableNumberWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  floorTableNumber: {
    fontWeight: "800",
    color: "#5C3A21",
    textShadowColor: "rgba(255,255,255,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  floorTableLabelWrap: {
    marginTop: 6,
    alignItems: "center",
    gap: 3,
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  statusChipText: {
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  floorTableTotal: {
    fontSize: 12,
    fontWeight: "800",
    color: "#FFFFFF",
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },

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
  modalItemRightCol: { alignItems: "flex-end", gap: 6 },
  modalItemLine: { fontSize: 14, color: premium.charcoalSoft },
  modalItemLineCanceled: {
    textDecorationLine: "line-through",
    color: premium.muted,
  },
  modalItemPrice: { fontSize: 14, fontWeight: "700", color: premium.charcoal },
  modalCancelReason: {
    fontSize: 12,
    fontStyle: "italic",
    color: premium.muted,
  },
  modalCancelPending: {
    fontSize: 12,
    fontWeight: "700",
    color: "#B45309",
  },
  cancelItemBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "rgba(220,38,38,0.1)",
    borderWidth: 1,
    borderColor: "rgba(220,38,38,0.35)",
  },
  cancelItemBtnPressed: { opacity: 0.8 },
  cancelItemBtnText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#DC2626",
    textTransform: "uppercase",
  },
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

  pendingSection: {
    marginHorizontal: 20,
    marginBottom: 16,
    padding: 14,
    borderRadius: 16,
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FDE68A",
    gap: 10,
  },
  pendingSectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#92400E",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  pendingCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    backgroundColor: "#FFFBEB",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FDE68A",
    padding: 12,
  },
  pendingCardText: { flex: 1, gap: 4 },
  pendingCardTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: premium.charcoal,
  },
  pendingCardReason: {
    fontSize: 12,
    fontStyle: "italic",
    color: premium.muted,
  },
  pendingCardActions: { flexDirection: "row", gap: 8 },
  pendingBtnPressed: { opacity: 0.85 },
  pendingRejectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(107,114,128,0.14)",
    borderWidth: 1,
    borderColor: "rgba(107,114,128,0.35)",
  },
  pendingRejectBtnText: { fontSize: 12, fontWeight: "800", color: "#4B5563" },
  pendingApproveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: premium.goldDark,
  },
  pendingApproveBtnText: { fontSize: 12, fontWeight: "800", color: "#fff" },

  // Overlay for the cancel-reason prompt, rendered INSIDE the table-detail
  // Modal (not as a second <Modal>) — see onRequestCloseTableModal comment
  // in the component for why. absoluteFillObject over `modalBackdrop`
  // (a View, so position:relative by default) covers the table card below.
  reasonOverlayBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 20,
  },
  reasonModalCard: {
    backgroundColor: premium.ivory,
    borderRadius: 20,
    padding: 20,
    gap: 14,
  },
  reasonModalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: premium.charcoal,
  },
  reasonModalSubtitle: { fontSize: 13, color: premium.muted },
  reasonModalInput: {
    minHeight: 70,
    borderWidth: 1,
    borderColor: premium.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: premium.charcoal,
    textAlignVertical: "top",
    backgroundColor: premium.ivoryDark,
  },
  reasonModalActions: { flexDirection: "row", gap: 10 },
  reasonModalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: premium.ivoryDark,
    borderWidth: 1,
    borderColor: premium.border,
  },
  reasonModalCancelBtnText: { fontWeight: "700", color: premium.charcoalSoft },
  reasonModalConfirmBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#DC2626",
  },
  reasonModalConfirmBtnText: { fontWeight: "800", color: "#fff" },
});
