import { useCallback, useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { fetchMenuFromApi, MENU_API_BASE } from "../services/menuApi";
import type { MenuItemRow } from "../types/database";
import { useSimulatorStore, type CartLine } from "../simulator/simulatorStore";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Guest">;

export function GuestMenuScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const guestTableId = useSimulatorStore((s) => s.guestTableId);
  const setGuestTableId = useSimulatorStore((s) => s.setGuestTableId);
  const guestCartQuantities = useSimulatorStore((s) => s.guestCartQuantities);
  const setGuestCartLine = useSimulatorStore((s) => s.setGuestCartLine);
  const submitGuestCartToKitchen = useSimulatorStore(
    (s) => s.submitGuestCartToKitchen
  );

  const [menuItems, setMenuItems] = useState<MenuItemRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // loadMenu is stable (empty deps); this runs when the Guest screen mounts.
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

  const onSubmit = () => {
    if (lines.length === 0) {
      Alert.alert("Cart empty", "Add at least one item.");
      return;
    }
    if (menuItems.length === 0) {
      Alert.alert("Menu not ready", "Wait for the menu to load.");
      return;
    }
    const outcome = submitGuestCartToKitchen(menuItems);
    if (outcome === "empty") {
      Alert.alert(
        "Cart empty",
        "No available items in the cart to send to the kitchen."
      );
      return;
    }
    Alert.alert("Order sent", "Kitchen will see this order in the simulator.");
    // REPLACE: POST /orders with table_id + lines; show server validation errors.
  };

  const sections = useMemo(() => {
    const byCat = new Map<string, MenuItemRow[]>();
    for (const m of menuItems) {
      if (!m.is_available) continue;
      const arr = byCat.get(m.category) ?? [];
      arr.push(m);
      byCat.set(m.category, arr);
    }
    return [...byCat.entries()].map(([title, data]) => ({ title, data }));
  }, [menuItems]);

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

      <SectionList
        style={styles.listFlex}
        sections={sections}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: 140 + insets.bottom },
        ]}
        ListHeaderComponent={
          <View style={styles.listHero}>
            <Text style={styles.menuKicker}>CHEF&apos;S MENU</Text>
            <Text style={styles.menuHead}>Selections</Text>
            <View style={styles.menuRule} />
            <Text style={styles.menuSub}>
              Tap + to add dishes to your order
            </Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.emptyMenu}>No items available.</Text>
        }
        renderSectionHeader={({ section: { title } }) => (
          <Text style={styles.sectionTitle}>{title}</Text>
        )}
        renderItem={({ item }) => {
          const q = guestCartQuantities[item.id] ?? 0;
          return (
            <View style={styles.card}>
              <View style={styles.cardRow}>
                <View style={styles.rowTextCol}>
                  <View style={styles.rowTitleRow}>
                    <Text style={styles.itemName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    <Text style={styles.itemPrice}>
                      ${item.price.toFixed(2)}
                    </Text>
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
                    <Text
                      style={[styles.stepBtnText, styles.stepBtnTextPlus]}
                    >
                      +
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
        }}
      />

      <View
        style={[
          styles.footer,
          {
            paddingBottom: Math.max(insets.bottom, 16),
          },
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
            (lines.length === 0 || isLoading || error != null) &&
              styles.primaryDisabled,
            pressed &&
              lines.length > 0 &&
              !isLoading &&
              error == null &&
              styles.primaryPressed,
          ]}
          onPress={onSubmit}
          disabled={lines.length === 0 || isLoading || error != null}
        >
          <Text style={styles.primaryText}>Place order</Text>
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
  menuHead: {
    fontSize: 32,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -1,
  },
  menuRule: {
    width: 48,
    height: 3,
    backgroundColor: premium.gold,
    borderRadius: 2,
    marginTop: 12,
    marginBottom: 10,
  },
  menuSub: {
    fontSize: 14,
    color: premium.charcoalSoft,
    lineHeight: 20,
    marginBottom: 12,
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
  sectionTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.muted,
    marginTop: 16,
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 2,
  },
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
