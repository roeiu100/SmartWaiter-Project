import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Alert,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
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

/** After 15 minutes the ticket is highlighted as late. */
const STALE_AFTER_MS = 15 * 60 * 1000;

const CURRENT_TIME_TICK_MS = 30 * 1000;

const ELAPSED_COLOR_FRESH_MS = 10 * 60 * 1000;
const ELAPSED_COLOR_WARN_MS = 15 * 60 * 1000;
const ELAPSED_COLOR_FRESH = "#22c55e";
const ELAPSED_COLOR_WARN = "#f59e0b";
const ELAPSED_COLOR_LATE = "#ef4444";

const COLLAPSED_ITEM_COUNT = 3;
const KDS_COLUMNS = 5;

const SCREEN_H_PAD = 10;
const COL_GAP = 6;
const ROW_GAP = 6;

const RUNNER_SOCKET_URL = (MENU_API_BASE ?? "").toString().trim();

const ITEM_INK = "#0A0A0A";
const NOTE_ALERT = "#EA580C";

const MODAL_WIDTH_FRAC = 0.78;
const MODAL_HEIGHT_FRAC = 0.76;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = minutes.toString().padStart(2, "0");
  const ss = seconds.toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function getOrderElapsedMs(createdAtIso: string, referenceTimeMs: number): number {
  const start = new Date(createdAtIso).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, referenceTimeMs - start);
}

function getElapsedTimeColor(ageMs: number): string {
  if (ageMs < ELAPSED_COLOR_FRESH_MS) return ELAPSED_COLOR_FRESH;
  if (ageMs < ELAPSED_COLOR_WARN_MS) return ELAPSED_COLOR_WARN;
  return ELAPSED_COLOR_LATE;
}

function formatPlacedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function computeKdsCardWidth(windowWidth: number): number {
  const inner = windowWidth - 2 * SCREEN_H_PAD;
  const totalGaps = (KDS_COLUMNS - 1) * COL_GAP;
  return (inner - totalGaps) / KDS_COLUMNS;
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

/** Orders with at least one ready line waiting for the runner. */
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

type RunnerTicketProps = {
  order: ActiveOrder;
  currentTime: number;
  isExpanded: boolean;
  cardWidth: number;
  onToggleExpand: () => void;
  onCollapseAccordion: () => void;
  onOpenTicketMenu: () => void;
  onServeItem: (orderId: string, itemId: string, status: ActiveOrderItemStatus) => void;
  onMarkAllDelivered: () => void;
  onOpenDetail: () => void;
};

function RunnerOrderTicket({
  order,
  currentTime,
  isExpanded,
  cardWidth,
  onToggleExpand,
  onCollapseAccordion,
  onOpenTicketMenu,
  onServeItem,
  onMarkAllDelivered,
  onOpenDetail,
}: RunnerTicketProps) {
  const ageMs = getOrderElapsedMs(order.created_at, currentTime);
  const isStale = ageMs >= STALE_AFTER_MS;
  const elapsedColor = getElapsedTimeColor(ageMs);

  const readyCount = order.items.filter((it) => it.status === "ready").length;
  const canDeliverAll = readyCount > 0;

  const totalItems = order.items.length;
  const hasHidden = totalItems > COLLAPSED_ITEM_COUNT;
  const hiddenCount = totalItems - COLLAPSED_ITEM_COUNT;
  const visibleItems =
    isExpanded || !hasHidden
      ? order.items
      : order.items.slice(0, COLLAPSED_ITEM_COUNT);

  const onPressCard = () => {
    if (isExpanded) {
      onCollapseAccordion();
      return;
    }
    onOpenDetail();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        isExpanded
          ? `Delivery ticket table ${order.table_id}. Tap to collapse.`
          : `Delivery ticket table ${order.table_id}. Tap for full detail.`
      }
      onPress={onPressCard}
      style={({ pressed }) => [
        styles.ticketOuter,
        { width: cardWidth },
        isStale && styles.ticketOuterStale,
        pressed && styles.ticketOuterPressed,
      ]}
    >
      <View style={styles.ticketHeader}>
        <View style={styles.ticketHeaderTap}>
          <View style={styles.ticketHeaderLeft}>
            <Text
              style={[styles.ticketTableLabel, isStale && styles.ticketTableLabelStale]}
              numberOfLines={1}
            >
              Table
            </Text>
            <Text style={styles.ticketTable} numberOfLines={1}>
              {order.table_id}
            </Text>
          </View>
          <View style={styles.ticketHeaderMid}>
            <Text
              style={[styles.ticketTime, { color: elapsedColor }]}
              numberOfLines={1}
            >
              {formatElapsed(ageMs)}
            </Text>
            <Text
              style={[styles.ticketStaleTag, !isStale && { opacity: 0 }]}
              numberOfLines={1}
            >
              LATE
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ticket menu"
          onPress={onOpenTicketMenu}
          hitSlop={8}
          style={({ pressed }) => [
            styles.menuDot,
            pressed && styles.menuDotPressed,
          ]}
        >
          <Text style={styles.menuDotText}>⋯</Text>
        </Pressable>
      </View>

      <View style={styles.ticketPerforation} />

      <View style={styles.ticketBody}>
        {visibleItems.map((line: ActiveOrderItem) => {
          const notes = (line.notes ?? "").trim();
          const isReady = line.status === "ready";
          const isServed = line.status === "served";
          const isPending = line.status === "pending";
          const done = isServed;
          const tappable = isReady;
          return (
            <Pressable
              key={line.id}
              accessibilityRole="checkbox"
              accessibilityState={{
                checked: isServed,
                disabled: !tappable,
              }}
              onPress={() => {
                if (tappable) onServeItem(order.id, line.id, line.status);
              }}
              disabled={!tappable}
              style={({ pressed }) => [
                styles.lineRow,
                pressed && tappable && styles.lineRowPressed,
                isPending && styles.lineRowPending,
              ]}
            >
              <View
                style={[
                  styles.checkbox,
                  isReady && styles.checkboxReady,
                  done && styles.checkboxDone,
                ]}
              >
                {done ? (
                  <Text style={styles.checkboxTick}>✓</Text>
                ) : null}
              </View>
              <Text
                style={[styles.lineQty, done && styles.lineDim, isPending && styles.lineDim]}
              >
                {line.quantity ?? 1}×
              </Text>
              <View style={styles.lineMain}>
                <Text
                  numberOfLines={isExpanded ? undefined : 2}
                  style={[styles.lineName, done && styles.lineNameDone]}
                >
                  {line.menu_item_name}
                </Text>
                {notes ? (
                  <Text
                    numberOfLines={isExpanded ? undefined : 1}
                    style={[
                      styles.lineNotes,
                      done && styles.lineDim,
                    ]}
                  >
                    {notes}
                  </Text>
                ) : null}
                {isPending ? (
                  <Text style={styles.lineStatusPending}>Kitchen</Text>
                ) : null}
                {isReady ? (
                  <Text style={styles.lineStatusReady}>Ready</Text>
                ) : null}
                {isServed ? (
                  <Text style={styles.lineStatusServed}>Delivered</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}

        {hasHidden ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isExpanded
                ? "Show fewer line items"
                : `Show ${hiddenCount} more items`
            }
            onPress={onToggleExpand}
            style={({ pressed }) => [
              styles.expandChip,
              pressed && styles.expandChipPressed,
            ]}
          >
            <Text style={styles.expandChipText}>
              {isExpanded ? "Show less" : `+${hiddenCount}`}
            </Text>
            <Text style={styles.expandDots}>{isExpanded ? "▲" : "⋯"}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.ticketFooter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Mark every ready dish on this ticket delivered"
          onPress={onMarkAllDelivered}
          disabled={!canDeliverAll}
          style={({ pressed }) => [
            styles.markDeliverBtn,
            !canDeliverAll && styles.markDeliverBtnOff,
            pressed && canDeliverAll && styles.markDeliverBtnPressed,
          ]}
        >
          <Text
            style={[
              styles.markDeliverBtnText,
              !canDeliverAll && styles.markDeliverBtnTextOff,
            ]}
            numberOfLines={1}
          >
            {canDeliverAll ? "Deliver all" : "None ready"}
          </Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

type RunnerDetailModalProps = {
  order: ActiveOrder;
  currentTime: number;
  modalWidth: number;
  modalHeight: number;
  onClose: () => void;
  onMarkAllDelivered: () => void;
};

function RunnerOrderDetailModal({
  order,
  currentTime,
  modalWidth,
  modalHeight,
  onClose,
  onMarkAllDelivered,
}: RunnerDetailModalProps) {
  const [checkedItems, setCheckedItems] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCheckedItems(new Set());
  }, [order.id]);

  const readyCount = order.items.filter((it) => it.status === "ready").length;
  const canDeliverAll = readyCount > 0;
  const ageMs = getOrderElapsedMs(order.created_at, currentTime);
  const isStale = ageMs >= STALE_AFTER_MS;
  const elapsedColor = getElapsedTimeColor(ageMs);

  const toggleLocalChecked = (itemId: string) => {
    const key = `${order.id}:${itemId}`;
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <Pressable
          style={styles.modalBackdrop}
          onPress={onClose}
          accessibilityLabel="Close detail view"
        />
        <View
          style={[
            styles.modalSheet,
            { width: modalWidth, maxHeight: modalHeight },
          ]}
        >
          <View style={styles.modalSheetHeader}>
            <View style={styles.modalSheetHeaderText}>
              <Text style={styles.modalKicker}>RUNNER TICKET</Text>
              <Text style={styles.modalTable}>{order.table_id}</Text>
              <Text style={[styles.modalElapsedHero, { color: elapsedColor }]}>
                {formatElapsed(ageMs)}
              </Text>
              <Text style={styles.modalPlacedAt}>
                {formatPlacedAt(order.created_at)}
              </Text>
              {isStale ? (
                <Text style={styles.modalStaleBanner}>OVERDUE TICKET</Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={12}
              style={({ pressed }) => [
                styles.modalCloseBtn,
                pressed && styles.modalCloseBtnPressed,
              ]}
            >
              <Text style={styles.modalCloseBtnText}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.modalBody}
            contentContainerStyle={styles.modalBodyContent}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.modalSectionTitle}>All items</Text>

            {order.items.map((line) => {
              const notes = (line.notes ?? "").trim();
              const isReady = line.status === "ready";
              const isServed = line.status === "served";
              const isPending = line.status === "pending";
              const statusLabel = isServed
                ? "Delivered"
                : isReady
                  ? "Ready to run"
                  : isPending
                    ? "In kitchen"
                    : "Unknown";
              const localKey = `${order.id}:${line.id}`;
              const locallyDone = checkedItems.has(localKey);
              return (
                <Pressable
                  key={line.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: locallyDone }}
                  onPress={() => toggleLocalChecked(line.id)}
                  style={({ pressed }) => [
                    styles.modalItemRow,
                    locallyDone && styles.modalItemRowDone,
                    pressed && styles.modalItemRowPressed,
                  ]}
                >
                  <View
                    style={[
                      styles.modalLocalCheckbox,
                      locallyDone && styles.modalLocalCheckboxOn,
                    ]}
                  >
                    {locallyDone ? (
                      <Text style={styles.modalLocalCheckboxTick}>✓</Text>
                    ) : null}
                  </View>
                  <View style={styles.modalItemTextCol}>
                    <Text
                      style={[
                        styles.modalLineTitle,
                        locallyDone && styles.modalLineTitleDone,
                      ]}
                    >
                      <Text
                        style={[
                          styles.modalLineQty,
                          locallyDone && styles.modalLineQtyDone,
                        ]}
                      >
                        {line.quantity ?? 1}×{" "}
                      </Text>
                      {line.menu_item_name}
                    </Text>
                    <Text
                      style={[
                        styles.modalLineStatus,
                        locallyDone && styles.modalLineStatusDone,
                      ]}
                    >
                      {statusLabel}
                      {locallyDone ? " · Checked (local)" : ""}
                    </Text>
                    {notes ? (
                      <View style={styles.modalNotesWrap}>
                        <Text style={styles.modalNotesLabel}>Special request</Text>
                        <Text
                          style={[
                            styles.modalNotesText,
                            locallyDone && styles.modalNotesTextDone,
                          ]}
                        >
                          {notes}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.modalFooter}>
            <Pressable
              style={({ pressed }) => [
                styles.modalFooterClose,
                pressed && styles.modalFooterClosePressed,
              ]}
              onPress={onClose}
            >
              <Text style={styles.modalFooterCloseText}>Close</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark every ready dish delivered"
              disabled={!canDeliverAll}
              onPress={() => {
                onMarkAllDelivered();
              }}
              style={({ pressed }) => [
                styles.modalFooterDeliver,
                !canDeliverAll && styles.modalFooterDeliverOff,
                pressed && canDeliverAll && styles.modalFooterDeliverPressed,
              ]}
            >
              <Text
                style={[
                  styles.modalFooterDeliverText,
                  !canDeliverAll && styles.modalFooterDeliverTextOff,
                ]}
              >
                {canDeliverAll ? "Mark all delivered" : "Nothing to deliver"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function RunnerDashboardScreen(_props: Props) {
  const { width, height } = useWindowDimensions();
  const cardWidth = useMemo(
    () => computeKdsCardWidth(Dimensions.get("window").width),
    [width]
  );
  const modalWidth = useMemo(
    () => Dimensions.get("window").width * MODAL_WIDTH_FRAC,
    [width]
  );
  const modalMaxHeight = useMemo(
    () => Dimensions.get("window").height * MODAL_HEIGHT_FRAC,
    [height]
  );

  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runnerAlerts, setRunnerAlerts] = useState<RunnerAlert[]>([]);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<ActiveOrder | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setSelectedOrder((prev) => {
      if (!prev) return null;
      return orders.find((o) => o.id === prev.id) ?? null;
    });
  }, [orders]);

  const queue = useMemo(() => getRunnerQueue(orders), [orders]);

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

  const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(
      () => setCurrentTime(Date.now()),
      CURRENT_TIME_TICK_MS
    );
    return () => clearInterval(id);
  }, []);

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

  useEffect(() => {
    setExpandedCardId((id) =>
      id && displayQueue.some((o) => o.id === id) ? id : null
    );
  }, [displayQueue]);

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
    (orderId: string, itemId: string, status: ActiveOrderItemStatus) => {
      if (status !== "ready") return;
      void flipItemStatus(orderId, itemId, "served");
    },
    [flipItemStatus]
  );

  const markAllDelivered = useCallback(
    async (order: ActiveOrder) => {
      for (const line of order.items) {
        if (line.status === "ready") {
          await flipItemStatus(order.id, line.id, "served");
        }
      }
      setManualOrderIds((prev) => prev.filter((id) => id !== order.id));
    },
    [flipItemStatus]
  );

  const moveToStart = useCallback((orderId: string) => {
    const currentIds = displayQueue.map((o) => o.id);
    if (currentIds.length === 0 || currentIds[0] === orderId) return;
    const rest = currentIds.filter((id) => id !== orderId);
    setManualOrderIds([orderId, ...rest]);
  }, [displayQueue]);

  const openTicketMenu = useCallback(
    (order: ActiveOrder) => {
      Alert.alert(
        `Table ${order.table_id}`,
        "Runner options",
        [
          { text: "Move to front", onPress: () => moveToStart(order.id) },
          {
            text: "Mark all delivered",
            onPress: () => void markAllDelivered(order),
          },
          { text: "Cancel", style: "cancel" },
        ],
        { cancelable: true }
      );
    },
    [markAllDelivered, moveToStart]
  );

  const toggleAccordionOrder = useCallback((orderId: string) => {
    setExpandedCardId((prev) => (prev === orderId ? null : orderId));
  }, []);

  const onMarkRequestComplete = useCallback((alertId: number) => {
    setRunnerAlerts((prev) => prev.filter((a) => a.id !== alertId));
    socketRef.current?.emit("clear_runner_alert", { id: alertId });
  }, []);

  const hasGridOrders = displayQueue.length > 0;
  const showEmptyState =
    !loadError && !hasGridOrders && runnerAlerts.length === 0;

  return (
    <View style={styles.screen}>
      <View style={styles.chrome}>
        <View style={styles.chromeRow}>
          <Text style={styles.chromeKicker}>RDS</Text>
          <Text style={styles.chromeTitle}>Ready to deliver</Text>
          <Text style={styles.chromeMeta} numberOfLines={2}>
            5-up grid · tap lines to deliver · tap ticket for detail · +N / Less
          </Text>
        </View>
        {loadError ? (
          <View style={styles.errorInline}>
            <Text style={styles.errorInlineText} numberOfLines={2}>
              {loadError}
            </Text>
            <Pressable
              style={styles.retryMini}
              onPress={() => void reload()}
            >
              <Text style={styles.retryMiniText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {runnerAlerts.length > 0 ? (
        <View style={styles.alertsStrip}>
          <Text style={styles.alertsStripTitle}>
            Table requests ({runnerAlerts.length})
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.alertsStripScroll}
          >
            {runnerAlerts.map((alert) => (
              <View key={alert.id} style={styles.alertChip}>
                <Text style={styles.alertChipTable} numberOfLines={1}>
                  Tbl {alert.table}
                </Text>
                <Text style={styles.alertChipBody} numberOfLines={2}>
                  {alert.request || "(no details)"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Mark request for table ${alert.table} complete`}
                  onPress={() => onMarkRequestComplete(alert.id)}
                  style={({ pressed }) => [
                    styles.alertChipBtn,
                    pressed && styles.alertChipBtnPressed,
                  ]}
                >
                  <Text style={styles.alertChipBtnText}>Done</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={[
          styles.gridScrollInner,
          { paddingHorizontal: SCREEN_H_PAD, paddingBottom: 20 },
        ]}
        showsVerticalScrollIndicator
      >
        {showEmptyState ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No deliveries</Text>
            <Text style={styles.emptySub}>
              Ready items and table requests appear here
            </Text>
          </View>
        ) : hasGridOrders ? (
          <View
            style={[
              styles.wrapGrid,
              {
                columnGap: COL_GAP,
                rowGap: ROW_GAP,
              },
            ]}
          >
            {displayQueue.map((order) => (
              <View key={order.id} style={{ width: cardWidth }}>
                <RunnerOrderTicket
                  order={order}
                  currentTime={currentTime}
                  isExpanded={expandedCardId === order.id}
                  cardWidth={cardWidth}
                  onToggleExpand={() => toggleAccordionOrder(order.id)}
                  onCollapseAccordion={() => setExpandedCardId(null)}
                  onOpenTicketMenu={() => openTicketMenu(order)}
                  onServeItem={onServeItem}
                  onMarkAllDelivered={() => void markAllDelivered(order)}
                  onOpenDetail={() => setSelectedOrder(order)}
                />
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No delivery tickets</Text>
            <Text style={styles.emptySub}>
              When the kitchen marks items ready, they appear here
            </Text>
          </View>
        )}
      </ScrollView>

      {selectedOrder ? (
        <RunnerOrderDetailModal
          order={selectedOrder}
          currentTime={currentTime}
          modalWidth={modalWidth}
          modalHeight={modalMaxHeight}
          onClose={() => setSelectedOrder(null)}
          onMarkAllDelivered={() => void markAllDelivered(selectedOrder)}
        />
      ) : null}
    </View>
  );
}

const STALE_TICKET_BG = "#FFF5F5";
const STALE_TICKET_BORDER = "#FECACA";
const STALE_ACCENT = "#B91C1C";

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#1C1917",
  },
  chrome: {
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: SCREEN_H_PAD,
    backgroundColor: "#0C0A09",
    borderBottomWidth: 1,
    borderBottomColor: "#292524",
  },
  chromeRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    flexWrap: "wrap",
  },
  chromeKicker: {
    fontSize: 11,
    fontWeight: "900",
    color: premium.runner,
    letterSpacing: 2,
  },
  chromeTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#FAFAF9",
    letterSpacing: -0.3,
    flexShrink: 0,
  },
  chromeMeta: {
    flex: 1,
    minWidth: 120,
    fontSize: 10,
    fontWeight: "600",
    color: "#A8A29E",
    textAlign: "right",
  },

  errorInline: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#450A0A",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "#7F1D1D",
  },
  errorInlineText: {
    flex: 1,
    color: "#FECACA",
    fontSize: 11,
    fontWeight: "600",
  },
  retryMini: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#B91C1C",
  },
  retryMiniText: {
    color: "#FFF",
    fontSize: 11,
    fontWeight: "800",
  },

  alertsStrip: {
    paddingVertical: 8,
    paddingHorizontal: SCREEN_H_PAD,
    backgroundColor: "#0f172a",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  alertsStripTitle: {
    fontSize: 10,
    fontWeight: "900",
    color: "#93c5fd",
    letterSpacing: 1.5,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  alertsStripScroll: {
    gap: 10,
    paddingRight: 8,
  },
  alertChip: {
    width: 200,
    backgroundColor: "#1e293b",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 8,
  },
  alertChipTable: {
    fontSize: 12,
    fontWeight: "900",
    color: "#e2e8f0",
    marginBottom: 4,
  },
  alertChipBody: {
    fontSize: 11,
    lineHeight: 15,
    color: "#94a3b8",
    marginBottom: 8,
  },
  alertChipBtn: {
    backgroundColor: "#2563eb",
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: "center",
  },
  alertChipBtnPressed: { opacity: 0.88 },
  alertChipBtnText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "900",
  },

  gridScroll: { flex: 1 },
  gridScrollInner: {
    flexGrow: 1,
    paddingTop: ROW_GAP,
  },
  wrapGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "flex-start",
    justifyContent: "flex-start",
    alignItems: "flex-start",
  },

  empty: {
    marginTop: 40,
    padding: 20,
    alignItems: "center",
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#E7E5E4",
  },
  emptySub: {
    marginTop: 4,
    fontSize: 13,
    color: "#A8A29E",
    textAlign: "center",
  },

  ticketOuter: {
    backgroundColor: "#FFFBF5",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#D6D3D1",
    borderLeftWidth: 4,
    borderLeftColor: premium.runner,
    overflow: "hidden",
    flexDirection: "column",
  },
  ticketOuterStale: {
    backgroundColor: STALE_TICKET_BG,
    borderColor: STALE_TICKET_BORDER,
    borderLeftColor: STALE_ACCENT,
  },
  ticketOuterPressed: { opacity: 0.94 },

  ticketHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F5F5F4",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#D6D3D1",
  },
  ticketHeaderTap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingTop: 5,
    paddingBottom: 4,
    paddingRight: 2,
  },
  ticketHeaderLeft: { flex: 1, minWidth: 0, paddingRight: 4 },
  ticketHeaderMid: {
    alignItems: "flex-end",
    flexShrink: 0,
    paddingRight: 4,
  },
  ticketTableLabel: {
    fontSize: 8,
    fontWeight: "900",
    color: "#57534E",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 1,
  },
  ticketTableLabelStale: { color: STALE_ACCENT },
  ticketTable: {
    fontSize: 15,
    fontWeight: "900",
    color: "#0C0A09",
    letterSpacing: -0.4,
  },
  ticketTime: {
    fontSize: 13,
    fontWeight: "900",
    fontVariant: ["tabular-nums"],
  },
  ticketStaleTag: {
    fontSize: 8,
    fontWeight: "900",
    color: STALE_ACCENT,
    letterSpacing: 0.5,
  },
  menuDot: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E7E5E4",
    borderWidth: 1,
    borderColor: "#D6D3D1",
    marginRight: 5,
  },
  menuDotPressed: { opacity: 0.85 },
  menuDotText: {
    fontSize: 14,
    fontWeight: "900",
    color: "#44403C",
    marginTop: -2,
  },

  ticketPerforation: {
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: "#D6D3D1",
  },

  ticketBody: {
    paddingHorizontal: 5,
    paddingTop: 4,
    paddingBottom: 4,
  },

  lineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 2,
    borderRadius: 4,
  },
  lineRowPressed: { backgroundColor: "rgba(0,0,0,0.05)" },
  lineRowPending: { opacity: 0.75 },
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: "#57534E",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
    backgroundColor: "transparent",
  },
  checkboxReady: {
    borderColor: premium.runner,
  },
  checkboxDone: {
    backgroundColor: premium.runner,
    borderColor: premium.runner,
  },
  checkboxTick: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "900",
    lineHeight: 10,
  },
  lineQty: {
    fontSize: 10,
    fontWeight: "900",
    color: premium.runner,
    minWidth: 18,
  },
  lineMain: { flex: 1, minWidth: 0 },
  lineName: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "800",
    color: ITEM_INK,
  },
  lineNameDone: {
    textDecorationLine: "line-through",
    color: "#78716C",
    fontWeight: "600",
  },
  lineDim: { color: "#A8A29E" },
  lineNotes: {
    marginTop: 1,
    fontSize: 9,
    lineHeight: 11,
    color: "#44403C",
    fontStyle: "italic",
  },
  lineStatusPending: {
    marginTop: 1,
    fontSize: 8,
    fontWeight: "900",
    color: "#78716C",
    textTransform: "uppercase",
  },
  lineStatusReady: {
    marginTop: 1,
    fontSize: 8,
    fontWeight: "900",
    color: premium.runner,
    textTransform: "uppercase",
  },
  lineStatusServed: {
    marginTop: 1,
    fontSize: 8,
    fontWeight: "900",
    color: "#A8A29E",
    textTransform: "uppercase",
  },

  expandChip: {
    marginTop: 4,
    marginBottom: 2,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#6ee7b7",
  },
  expandChipPressed: { opacity: 0.9 },
  expandChipText: {
    fontSize: 10,
    fontWeight: "900",
    color: premium.runner,
  },
  expandDots: {
    fontSize: 11,
    fontWeight: "900",
    color: premium.runner,
  },

  ticketFooter: {
    borderTopWidth: 1,
    borderTopColor: "#D6D3D1",
    paddingHorizontal: 5,
    paddingVertical: 4,
    backgroundColor: "#F5F5F4",
  },
  markDeliverBtn: {
    backgroundColor: premium.runner,
    paddingVertical: 5,
    borderRadius: 4,
    alignItems: "center",
  },
  markDeliverBtnPressed: { opacity: 0.92 },
  markDeliverBtnOff: {
    backgroundColor: "#D6D3D1",
  },
  markDeliverBtnText: {
    color: "#FFFAF0",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.4,
  },
  markDeliverBtnTextOff: {
    color: "#57534E",
  },

  modalRoot: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.74)",
  },
  modalSheet: {
    zIndex: 2,
    elevation: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E7E5E4",
    flexDirection: "column",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
  },
  modalSheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: "#FAFAF9",
    borderBottomWidth: 1,
    borderBottomColor: "#E7E5E4",
  },
  modalSheetHeaderText: { flex: 1, minWidth: 0, paddingRight: 12 },
  modalKicker: {
    fontSize: 11,
    fontWeight: "900",
    color: premium.runner,
    letterSpacing: 2,
    marginBottom: 6,
  },
  modalTable: {
    fontSize: 34,
    fontWeight: "900",
    color: "#0C0A09",
    letterSpacing: -1,
  },
  modalElapsedHero: {
    marginTop: 8,
    fontSize: 28,
    fontWeight: "900",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
  },
  modalPlacedAt: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: "600",
    color: "#57534E",
  },
  modalStaleBanner: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: "900",
    color: STALE_ACCENT,
    letterSpacing: 1,
  },
  modalCloseBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F5F5F4",
    borderWidth: 1,
    borderColor: "#D6D3D1",
  },
  modalCloseBtnPressed: { opacity: 0.88 },
  modalCloseBtnText: {
    fontSize: 22,
    fontWeight: "700",
    color: "#44403C",
    lineHeight: 24,
  },
  modalBody: { flexGrow: 1, flexShrink: 1, minHeight: 120 },
  modalBodyContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 20,
  },
  modalSectionTitle: {
    fontSize: 14,
    fontWeight: "900",
    color: "#1C1917",
    letterSpacing: 0.5,
    marginBottom: 14,
  },
  modalItemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#D6D3D1",
  },
  modalItemRowPressed: { opacity: 0.92 },
  modalItemRowDone: { opacity: 0.48 },
  modalLocalCheckbox: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#57534E",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
    backgroundColor: "#FFFFFF",
  },
  modalLocalCheckboxOn: {
    backgroundColor: "#22c55e",
    borderColor: "#16a34a",
  },
  modalLocalCheckboxTick: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "900",
  },
  modalItemTextCol: { flex: 1, minWidth: 0 },
  modalLineTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "800",
    color: ITEM_INK,
  },
  modalLineTitleDone: {
    textDecorationLine: "line-through",
    color: "#78716C",
  },
  modalLineQty: {
    fontSize: 22,
    fontWeight: "900",
    color: premium.runner,
  },
  modalLineQtyDone: {
    color: "#A8A29E",
  },
  modalLineStatus: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: "800",
    color: "#78716C",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  modalLineStatusDone: {
    color: "#A8A29E",
  },
  modalNotesWrap: {
    marginTop: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FFF7ED",
    borderWidth: 1,
    borderColor: "#FDBA74",
  },
  modalNotesLabel: {
    fontSize: 11,
    fontWeight: "900",
    color: NOTE_ALERT,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  modalNotesText: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: "700",
    color: NOTE_ALERT,
  },
  modalNotesTextDone: {
    textDecorationLine: "line-through",
    opacity: 0.85,
  },
  modalFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: "#E7E5E4",
    backgroundColor: "#FAFAF9",
  },
  modalFooterClose: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: "#E7E5E4",
    borderWidth: 1,
    borderColor: "#D6D3D1",
  },
  modalFooterClosePressed: { opacity: 0.9 },
  modalFooterCloseText: {
    fontSize: 16,
    fontWeight: "900",
    color: "#292524",
  },
  modalFooterDeliver: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: premium.runner,
  },
  modalFooterDeliverPressed: { opacity: 0.92 },
  modalFooterDeliverOff: {
    backgroundColor: "#D6D3D1",
  },
  modalFooterDeliverText: {
    fontSize: 16,
    fontWeight: "900",
    color: "#FFFAF0",
  },
  modalFooterDeliverTextOff: {
    color: "#57534E",
  },
});
