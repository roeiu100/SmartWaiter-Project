import { useCallback, useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { fetchMenuFromApi, MENU_API_BASE } from "../services/menuApi";
import { submitOrder } from "../services/orderApi";
import type { MenuItemRow } from "../types/database";
import { useSimulatorStore, type CartLine } from "../simulator/simulatorStore";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Guest">;

/**
 * Which category shows first on the picker. Lower rank = earlier.
 * Anything not in the list falls to the end, then sorts alphabetically
 * so new categories added by the manager just appear at the bottom.
 */
function categoryRank(name: string): number {
  const n = name.toLowerCase().trim();
  if (n === "food") return 0;
  if (n === "desserts" || n === "dessert") return 1;
  if (n === "drinks" || n === "drink") return 2;
  return 3;
}

function titleCase(name: string): string {
  const s = name.trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

interface CategoryEntry {
  key: string;
  label: string;
  count: number;
  inCart: number;
}

export function GuestMenuScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const guestTableId = useSimulatorStore((s) => s.guestTableId);
  const setGuestTableId = useSimulatorStore((s) => s.setGuestTableId);
  const guestCartQuantities = useSimulatorStore((s) => s.guestCartQuantities);
  const setGuestCartLine = useSimulatorStore((s) => s.setGuestCartLine);
  const clearGuestCart = useSimulatorStore((s) => s.clearGuestCart);
  const [submitting, setSubmitting] = useState(false);

  const [menuItems, setMenuItems] = useState<MenuItemRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Currently-open category key, or null to show the category picker. */
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const loadMenu = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    const menuUrl = `${MENU_API_BASE}/api/menu`;
    if (!silent) {
      console.log("Menu fetch URL:", menuUrl);
      setIsLoading(true);
      setError(null);
    }
    try {
      const data = await fetchMenuFromApi();
      if (!silent) {
        console.log("Data received from backend:", data);
      }
      setMenuItems(data);
      if (silent) {
        setError(null);
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not load menu";
      if (silent) {
        console.warn("[GuestMenu] Silent menu refresh failed:", message);
      } else {
        setError(message);
        console.log("Menu fetch full error:", e);
      }
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  useEffect(() => {
    const baseUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
    if (!baseUrl) {
      console.warn(
        "[GuestMenu] EXPO_PUBLIC_API_URL is not set; Socket.io menu sync disabled"
      );
      return;
    }
    const socket = io(baseUrl, {
      transports: ["websocket", "polling"],
    });
    const onMenuUpdated = () => {
      void loadMenu({ silent: true });
    };
    socket.on("menu_updated", onMenuUpdated);
    return () => {
      socket.off("menu_updated", onMenuUpdated);
      socket.disconnect();
    };
  }, [loadMenu]);

  const lines: CartLine[] = useMemo(() => {
    return Object.entries(guestCartQuantities)
      .filter(([, q]) => q > 0)
      .map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
  }, [guestCartQuantities]);

  const total = useMemo(() => {
    let sum = 0;
    for (const line of lines) {
      const m = menuItems.find((x) => x.id === line.menuItemId);
      if (m) sum += m.price * line.quantity;
    }
    return Math.round(sum * 100) / 100;
  }, [lines, menuItems]);

  const itemCount = useMemo(
    () => lines.reduce((n, l) => n + l.quantity, 0),
    [lines]
  );

  const bump = useCallback(
    (id: string, delta: number) => {
      const prev =
        useSimulatorStore.getState().guestCartQuantities[id] ?? 0;
      setGuestCartLine(id, Math.max(0, prev + delta));
    },
    [setGuestCartLine]
  );

  const onSubmit = useCallback(async () => {
    if (lines.length === 0) {
      Alert.alert("Cart empty", "Add at least one item.");
      return;
    }
    if (menuItems.length === 0) {
      Alert.alert("Menu not ready", "Wait for the menu to load.");
      return;
    }
    const tableId = (guestTableId ?? "").trim();
    if (!tableId) {
      Alert.alert("Table required", "Enter your table id before ordering.");
      return;
    }
    setSubmitting(true);
    try {
      const availableIds = new Set(
        menuItems.filter((m) => m.is_available).map((m) => m.id)
      );
      const apiLines = lines
        .filter((l) => availableIds.has(l.menuItemId))
        .map((l) => ({
          menu_item_id: l.menuItemId,
          quantity: l.quantity,
        }));
      if (apiLines.length === 0) {
        Alert.alert(
          "Cart empty",
          "No available items in the cart to send to the kitchen."
        );
        return;
      }
      await submitOrder(tableId, apiLines);
      clearGuestCart();
      setSelectedCategory(null);
      Alert.alert("Order sent", "The kitchen is preparing your order.");
    } catch (err) {
      console.error("[GuestMenu] submitOrder failed:", err);
      Alert.alert(
        "Could not send order",
        err instanceof Error ? err.message : "Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }, [lines, menuItems, guestTableId, clearGuestCart]);

  /** All available categories, sorted (food, desserts, drinks, …others). */
  const categories: CategoryEntry[] = useMemo(() => {
    const byCat = new Map<string, MenuItemRow[]>();
    for (const m of menuItems) {
      if (!m.is_available) continue;
      const arr = byCat.get(m.category) ?? [];
      arr.push(m);
      byCat.set(m.category, arr);
    }
    const entries: CategoryEntry[] = [];
    for (const [key, items] of byCat.entries()) {
      const inCart = items.reduce(
        (sum, it) => sum + (guestCartQuantities[it.id] ?? 0),
        0
      );
      entries.push({
        key,
        label: titleCase(key),
        count: items.length,
        inCart,
      });
    }
    entries.sort((a, b) => {
      const ra = categoryRank(a.key);
      const rb = categoryRank(b.key);
      if (ra !== rb) return ra - rb;
      return a.label.localeCompare(b.label);
    });
    return entries;
  }, [menuItems, guestCartQuantities]);

  /** When a category disappears (manager toggled off the last item), fall back to picker. */
  useEffect(() => {
    if (selectedCategory == null) return;
    if (!categories.some((c) => c.key === selectedCategory)) {
      setSelectedCategory(null);
    }
  }, [categories, selectedCategory]);

  const itemsInCategory: MenuItemRow[] = useMemo(() => {
    if (!selectedCategory) return [];
    return menuItems.filter(
      (m) => m.is_available && m.category === selectedCategory
    );
  }, [menuItems, selectedCategory]);

  const renderCategoryCard = useCallback(
    ({ item }: { item: CategoryEntry }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.label} section`}
        onPress={() => setSelectedCategory(item.key)}
        style={({ pressed }) => [
          styles.categoryCard,
          pressed && styles.categoryCardPressed,
        ]}
      >
        <View style={styles.categoryTextCol}>
          <Text style={styles.categoryName}>{item.label}</Text>
          <Text style={styles.categoryMeta}>
            {item.count} {item.count === 1 ? "item" : "items"}
            {item.inCart > 0 ? ` • ${item.inCart} in cart` : ""}
          </Text>
        </View>
        <Text style={styles.categoryChevron}>›</Text>
      </Pressable>
    ),
    []
  );

  const renderItemCard = useCallback(
    ({ item }: { item: MenuItemRow }) => {
      const q = guestCartQuantities[item.id] ?? 0;
      return (
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <View style={styles.rowTextCol}>
              <View style={styles.rowTitleRow}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={styles.itemPrice}>${item.price.toFixed(2)}</Text>
              </View>
              {item.description ? (
                <Text style={styles.itemDesc}>{item.description}</Text>
              ) : null}
            </View>
            <View style={styles.stepper}>
              <Pressable
                onPress={() => bump(item.id, -1)}
                style={({ pressed }) => [
                  styles.stepBtn,
                  q === 0 && styles.stepBtnDisabled,
                  pressed && q > 0 && styles.stepBtnPressed,
                ]}
                hitSlop={8}
                disabled={q === 0}
              >
                <Text style={styles.stepBtnText}>−</Text>
              </Pressable>
              <Text style={styles.qty}>{q}</Text>
              <Pressable
                onPress={() => bump(item.id, 1)}
                style={({ pressed }) => [
                  styles.stepBtn,
                  styles.stepBtnPlus,
                  pressed && styles.stepBtnPressed,
                ]}
                hitSlop={8}
              >
                <Text style={[styles.stepBtnText, styles.stepBtnTextPlus]}>
                  +
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      );
    },
    [bump, guestCartQuantities]
  );

  const listPaddingBottom = 140 + insets.bottom;

  return (
    <View style={styles.root}>
      <View style={styles.tablePanel}>
        <Text style={styles.tableLabel}>Table</Text>
        <TextInput
          value={guestTableId}
          onChangeText={setGuestTableId}
          placeholder="e.g. T12"
          placeholderTextColor={premium.mutedLight}
          style={styles.input}
          autoCapitalize="characters"
        />
      </View>

      {isLoading ? (
        <View style={styles.loadingBanner}>
          <ActivityIndicator size="large" color={premium.gold} />
        </View>
      ) : null}

      {error != null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void loadMenu()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {selectedCategory == null ? (
        <FlatList
          style={styles.listFlex}
          data={categories}
          keyExtractor={(c) => c.key}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: listPaddingBottom },
          ]}
          ListHeaderComponent={
            <View style={styles.listHero}>
              <Text style={styles.menuKicker}>CHEF&apos;S MENU</Text>
            </View>
          }
          ListEmptyComponent={
            !isLoading ? (
              <Text style={styles.emptyMenu}>No items available.</Text>
            ) : null
          }
          renderItem={renderCategoryCard}
        />
      ) : (
        <FlatList
          style={styles.listFlex}
          data={itemsInCategory}
          keyExtractor={(m) => m.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: listPaddingBottom },
          ]}
          ListHeaderComponent={
            <View style={styles.categoryHeader}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to all categories"
                onPress={() => setSelectedCategory(null)}
                style={({ pressed }) => [
                  styles.backBtn,
                  pressed && styles.backBtnPressed,
                ]}
              >
                <Text style={styles.backBtnLabel}>‹ All categories</Text>
              </Pressable>
              <Text style={styles.categoryHeaderTitle}>
                {titleCase(selectedCategory)}
              </Text>
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.emptyMenu}>No items in this section.</Text>
          }
          renderItem={renderItemCard}
        />
      )}

      <View
        style={[
          styles.footer,
          { paddingBottom: Math.max(insets.bottom, 16) },
        ]}
      >
        <View style={styles.footerRow}>
          <View>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.total}>${total.toFixed(2)}</Text>
          </View>
          <Text style={styles.footerMeta}>
            {itemCount === 0
              ? "No items"
              : `${itemCount} item${itemCount === 1 ? "" : "s"}`}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.primary,
            (lines.length === 0 || isLoading || error != null || submitting) &&
              styles.primaryDisabled,
            pressed &&
              lines.length > 0 &&
              !isLoading &&
              error == null &&
              !submitting &&
              styles.primaryPressed,
          ]}
          onPress={() => void onSubmit()}
          disabled={
            lines.length === 0 || isLoading || error != null || submitting
          }
        >
          <Text style={styles.primaryText}>
            {submitting ? "Sending…" : "Place order"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const CARD_ELEVATION = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
  },
  default: { elevation: 6 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: premium.screen },
  listFlex: { flex: 1 },
  loadingBanner: {
    paddingVertical: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: premium.screen,
  },
  errorBanner: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    alignItems: "center",
    gap: 12,
    backgroundColor: premium.screen,
  },
  errorText: {
    fontSize: 15,
    color: "#DC2626",
    textAlign: "center",
    lineHeight: 22,
    width: "100%",
  },
  retryBtn: {
    backgroundColor: premium.goldDark,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  retryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  emptyMenu: {
    fontSize: 15,
    color: premium.muted,
    marginTop: 8,
    marginBottom: 24,
    paddingHorizontal: 4,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  listHero: {
    marginBottom: 8,
  },
  menuKicker: {
    fontSize: 14,
    fontWeight: "700",
    color: premium.goldDark,
    letterSpacing: 2.5,
    marginBottom: 8,
  },

  // Category picker
  categoryCard: {
    backgroundColor: premium.ivory,
    borderRadius: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: premium.border,
    borderLeftWidth: 4,
    borderLeftColor: premium.gold,
    paddingVertical: 22,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    ...CARD_ELEVATION,
  },
  categoryCardPressed: { opacity: 0.92 },
  categoryTextCol: { flex: 1, minWidth: 0 },
  categoryName: {
    fontSize: 24,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.6,
  },
  categoryMeta: {
    marginTop: 4,
    fontSize: 13,
    color: premium.muted,
    fontWeight: "600",
  },
  categoryChevron: {
    fontSize: 32,
    fontWeight: "700",
    color: premium.goldDark,
    marginLeft: 8,
    marginTop: -4,
  },

  // Inside-category header (back link + section title)
  categoryHeader: {
    marginBottom: 12,
    gap: 10,
  },
  backBtn: {
    alignSelf: "flex-start",
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  backBtnPressed: { opacity: 0.7 },
  backBtnLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: premium.goldDark,
    letterSpacing: 0.3,
  },
  categoryHeaderTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.6,
  },

  tablePanel: {
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 16,
    backgroundColor: premium.ivory,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: premium.border,
    ...CARD_ELEVATION,
  },
  tableLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: premium.muted,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    width: 52,
  },
  input: {
    flex: 1,
    fontSize: 22,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: 0.5,
    paddingVertical: 4,
  },

  // Item cards (inside a category)
  card: {
    backgroundColor: premium.ivory,
    borderRadius: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: premium.border,
    borderTopWidth: 3,
    borderTopColor: premium.gold,
    ...CARD_ELEVATION,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 18,
    paddingHorizontal: 18,
  },
  rowTextCol: { flex: 1, minWidth: 0 },
  rowTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  itemName: {
    flex: 1,
    fontSize: 19,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.4,
  },
  itemDesc: {
    fontSize: 14,
    lineHeight: 21,
    color: premium.muted,
    marginTop: 8,
  },
  itemPrice: {
    fontSize: 18,
    fontWeight: "800",
    color: premium.goldDark,
    letterSpacing: -0.3,
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 2 },
  stepBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: premium.ivoryDark,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: premium.border,
  },
  stepBtnPlus: {
    backgroundColor: premium.goldMuted,
    borderColor: premium.gold,
  },
  stepBtnDisabled: { opacity: 0.45 },
  stepBtnPressed: { opacity: 0.85 },
  stepBtnText: { fontSize: 20, color: premium.charcoalSoft, fontWeight: "500" },
  stepBtnTextPlus: { color: premium.goldDark, fontWeight: "800" },
  qty: {
    minWidth: 26,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "800",
    color: premium.charcoal,
  },

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
