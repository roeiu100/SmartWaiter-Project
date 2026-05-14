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

type Props = NativeStackScreenProps<RootStackParamList, "Kitchen">;

/** After 15 minutes the card turns pink to alert chefs. */
const STALE_AFTER_MS = 15 * 60 * 1000;

/** Live clock tick — re-renders elapsed labels and time colors on the grid. */
const CURRENT_TIME_TICK_MS = 30 * 1000;

/** Elapsed time color tiers (compact card timer). */
const ELAPSED_COLOR_FRESH_MS = 10 * 60 * 1000;
const ELAPSED_COLOR_WARN_MS = 15 * 60 * 1000;
const ELAPSED_COLOR_FRESH = "#22c55e";
const ELAPSED_COLOR_WARN = "#f59e0b";
const ELAPSED_COLOR_LATE = "#ef4444";

/** Collapsed ticket shows this many item lines before "+X more". */
const COLLAPSED_ITEM_COUNT = 3;

/** Fixed KDS columns — each slot is 1/5 of usable width (minus gaps). */
const KDS_COLUMNS = 5;

const SCREEN_H_PAD = 10;
const COL_GAP = 6;
const ROW_GAP = 6;

const KITCHEN_SOCKET_URL = (MENU_API_BASE ?? "").toString().trim();

/** Item name: maximum contrast on white ticket paper. */
const ITEM_INK = "#0A0A0A";

/** Notes / special requests in detail modal — high visibility. */
const NOTE_ALERT = "#EA580C";

/** Detail modal size as fraction of window (tablet-friendly). */
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

/** Milliseconds since `created_at` relative to a wall-clock instant (e.g. `currentTime`). */
function getOrderElapsedMs(createdAtIso: string, referenceTimeMs: number): number {
  const start = new Date(createdAtIso).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, referenceTimeMs - start);
}

/** Timer color on compact cards: green → orange → red. */
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

/** Five equal columns: (window − horizontal padding − gaps) / 5 ≈ 20% each. */
function computeKdsCardWidth(windowWidth: number): number {
  const inner = windowWidth - 2 * SCREEN_H_PAD;
  const totalGaps = (KDS_COLUMNS - 1) * COL_GAP;
  return (inner - totalGaps) / KDS_COLUMNS;
}

/** Derived kitchen queue: orders that still have pending items to prepare. */
function getKitchenQueue(orders: ActiveOrder[]): ActiveOrder[] {
  return orders.filter(
    (o) =>
      o.status !== "delivered" &&
      o.items.some((it) => it.status === "pending")
  );
}

type OrderTicketProps = {
  order: ActiveOrder;
  currentTime: number;
  isExpanded: boolean;
  cardWidth: number;
  onToggleExpand: () => void;
  onCollapseAccordion: () => void;
  onOpenTicketMenu: () => void;
  onToggleItemReady: (
    orderId: string,
    itemId: string,
    currentStatus: ActiveOrderItemStatus
  ) => void;
  onMarkAllReady: () => void;
  onOpenDetail: () => void;
};

function OrderTicket({
  order,
  currentTime,
  isExpanded,
  cardWidth,
  onToggleExpand,
  onCollapseAccordion,
  onOpenTicketMenu,
  onToggleItemReady,
  onMarkAllReady,
  onOpenDetail,
}: OrderTicketProps) {
  const ageMs = getOrderElapsedMs(order.created_at, currentTime);
  const isStale = ageMs >= STALE_AFTER_MS;
  const elapsedColor = getElapsedTimeColor(ageMs);

  const pendingCount = order.items.filter((it) => it.status === "pending")
    .length;
  const canMarkAll = pendingCount > 0;

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
          ? `Ticket table ${order.table_id}. Tap to collapse list.`
          : `Ticket table ${order.table_id}. Tap for full detail.`
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
                onToggleItemReady(order.id, line.id, line.status)
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
                {isReady ? (
                  <Text style={styles.lineStatusReady}>Runner</Text>
                ) : null}
                {isServed ? (
                  <Text style={styles.lineStatusServed}>Out</Text>
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
          accessibilityLabel="Mark all dishes on this ticket ready"
          onPress={onMarkAllReady}
          disabled={!canMarkAll}
          style={({ pressed }) => [
            styles.markReadyBtn,
            !canMarkAll && styles.markReadyBtnOff,
            pressed && canMarkAll && styles.markReadyBtnPressed,
          ]}
        >
          <Text
            style={[
              styles.markReadyBtnText,
              !canMarkAll && styles.markReadyBtnTextOff,
            ]}
            numberOfLines={1}
          >
            {canMarkAll ? "Ready" : "Done"}
          </Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

type OrderDetailModalProps = {
  order: ActiveOrder;
  currentTime: number;
  modalWidth: number;
  modalHeight: number;
  onClose: () => void;
  onMarkAllReady: () => void;
};

function OrderDetailModal({
  order,
  currentTime,
  modalWidth,
  modalHeight,
  onClose,
  onMarkAllReady,
}: OrderDetailModalProps) {
  const [checkedItems, setCheckedItems] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCheckedItems(new Set());
  }, [order.id]);

  const pendingCount = order.items.filter((it) => it.status === "pending")
    .length;
  const canMarkAll = pendingCount > 0;
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
              <Text style={styles.modalKicker}>DETAILED TICKET</Text>
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
              const statusLabel = isServed
                ? "Delivered"
                : isReady
                  ? "Ready"
                  : "Pending";
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
                      {locallyDone ? " · Cooked (local)" : ""}
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
              accessibilityLabel="Mark all dishes ready"
              disabled={!canMarkAll}
              onPress={() => {
                onMarkAllReady();
              }}
              style={({ pressed }) => [
                styles.modalFooterReady,
                !canMarkAll && styles.modalFooterReadyOff,
                pressed && canMarkAll && styles.modalFooterReadyPressed,
              ]}
            >
              <Text
                style={[
                  styles.modalFooterReadyText,
                  !canMarkAll && styles.modalFooterReadyTextOff,
                ]}
              >
                {canMarkAll ? "Mark all ready" : "All ready"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function KitchenDashboardScreen(_props: Props) {
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
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<ActiveOrder | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setSelectedOrder((prev) => {
      if (!prev) return null;
      return orders.find((o) => o.id === prev.id) ?? null;
    });
  }, [orders]);

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
    },
    [markAllAsReady, moveToStart]
  );

  const toggleAccordionOrder = useCallback((orderId: string) => {
    setExpandedCardId((prev) => (prev === orderId ? null : orderId));
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.chrome}>
        <View style={styles.chromeRow}>
          <Text style={styles.chromeKicker}>KDS</Text>
          <Text style={styles.chromeTitle}>Live queue</Text>
          <Text style={styles.chromeMeta} numberOfLines={1}>
            One expanded ticket · tap ticket to collapse or detail · +N / Less
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

      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={[
          styles.gridScrollInner,
          { paddingHorizontal: SCREEN_H_PAD, paddingBottom: 20 },
        ]}
        showsVerticalScrollIndicator
      >
        {displayQueue.length === 0 && !loadError ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>No active tickets</Text>
          </View>
        ) : (
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
              <View
                key={order.id}
                style={{ width: cardWidth }}
              >
                <OrderTicket
                  order={order}
                  currentTime={currentTime}
                  isExpanded={expandedCardId === order.id}
                  cardWidth={cardWidth}
                  onToggleExpand={() => toggleAccordionOrder(order.id)}
                  onCollapseAccordion={() => setExpandedCardId(null)}
                  onOpenTicketMenu={() => openTicketMenu(order)}
                  onToggleItemReady={toggleItemReady}
                  onMarkAllReady={() => void markAllAsReady(order)}
                  onOpenDetail={() => setSelectedOrder(order)}
                />
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {selectedOrder ? (
        <OrderDetailModal
          order={selectedOrder}
          currentTime={currentTime}
          modalWidth={modalWidth}
          modalHeight={modalMaxHeight}
          onClose={() => setSelectedOrder(null)}
          onMarkAllReady={() => void markAllAsReady(selectedOrder)}
        />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  KDS — 5-up wrap grid, variable-height tickets, detail modal        */
/* ------------------------------------------------------------------ */

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
    color: "#F97316",
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
    /** Row height follows tallest ticket; cards keep natural height (no vertical stretch). */
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
  },

  ticketOuter: {
    backgroundColor: "#FFFBF5",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#D6D3D1",
    borderLeftWidth: 4,
    borderLeftColor: premium.kitchen,
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
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: "#57534E",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
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
    color: premium.kitchen,
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
    backgroundColor: "#FFF7ED",
    borderWidth: 1,
    borderColor: "#FDBA74",
  },
  expandChipPressed: { opacity: 0.9 },
  expandChipText: {
    fontSize: 10,
    fontWeight: "900",
    color: premium.kitchen,
  },
  expandDots: {
    fontSize: 11,
    fontWeight: "900",
    color: premium.kitchen,
  },

  ticketFooter: {
    borderTopWidth: 1,
    borderTopColor: "#D6D3D1",
    paddingHorizontal: 5,
    paddingVertical: 4,
    backgroundColor: "#F5F5F4",
  },
  markReadyBtn: {
    backgroundColor: premium.kitchen,
    paddingVertical: 5,
    borderRadius: 4,
    alignItems: "center",
  },
  markReadyBtnPressed: { opacity: 0.92 },
  markReadyBtnOff: {
    backgroundColor: "#D6D3D1",
  },
  markReadyBtnText: {
    color: "#FFFAF0",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.4,
  },
  markReadyBtnTextOff: {
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
    color: premium.kitchen,
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
    color: premium.kitchen,
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
  modalFooterReady: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: premium.kitchen,
  },
  modalFooterReadyPressed: { opacity: 0.92 },
  modalFooterReadyOff: {
    backgroundColor: "#D6D3D1",
  },
  modalFooterReadyText: {
    fontSize: 16,
    fontWeight: "900",
    color: "#FFFAF0",
  },
  modalFooterReadyTextOff: {
    color: "#57534E",
  },
});
