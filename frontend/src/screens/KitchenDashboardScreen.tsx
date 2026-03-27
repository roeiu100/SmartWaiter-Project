import { useMemo } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { RootStackParamList } from "../navigation/AppNavigator";
import {
  getKitchenQueue,
  useSimulatorStore,
} from "../simulator/simulatorStore";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Kitchen">;

export function KitchenDashboardScreen(_props: Props) {
  const orders = useSimulatorStore((s) => s.orders);
  const queue = useMemo(() => getKitchenQueue(orders), [orders]);
  const markOrderReady = useSimulatorStore((s) => s.markOrderReady);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      <View style={styles.intro}>
        <Text style={styles.introKicker}>KITCHEN</Text>
        <Text style={styles.introTitle}>Order queue</Text>
        <View style={styles.introRule} />
        <Text style={styles.hint}>
          New tickets appear when a guest orders. Mark ready when plated.
        </Text>
      </View>

      {queue.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>◇</Text>
          <Text style={styles.emptyTitle}>All caught up</Text>
          <Text style={styles.emptyText}>No active tickets</Text>
        </View>
      ) : (
        queue.map((order) => (
          <View key={order.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.tableLabel}>Table</Text>
                <Text style={styles.table}>{order.table_id}</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>In prep</Text>
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.metaRow}>
              <Text style={styles.metaKey}>Ticket</Text>
              <Text style={styles.metaVal} numberOfLines={1}>
                {order.id}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaKey}>Total</Text>
              <Text style={styles.totalPrice}>${order.total_price.toFixed(2)}</Text>
            </View>

            <Text style={styles.itemsHead}>Items</Text>
            <View style={styles.items}>
              {order.items.map((line) => (
                <View key={line.id} style={styles.lineRow}>
                  <Text style={styles.lineQty}>{line.quantity ?? 1}×</Text>
                  <Text style={styles.line}>{line.menu_name}</Text>
                </View>
              ))}
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.primary,
                pressed && styles.primaryPressed,
              ]}
              onPress={() => markOrderReady(order.id)}
            >
              <Text style={styles.primaryText}>Mark ready for runner</Text>
            </Pressable>
          </View>
        ))
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
    backgroundColor: premium.ivory,
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
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  tableLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.kitchen,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 2,
  },
  table: {
    fontSize: 30,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.5,
  },
  badge: {
    backgroundColor: premium.kitchenSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(194, 65, 12, 0.3)",
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "800",
    color: premium.kitchen,
  },
  divider: {
    height: 1,
    backgroundColor: premium.border,
    marginVertical: 14,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    gap: 12,
  },
  metaKey: { fontSize: 13, color: premium.muted, fontWeight: "600" },
  metaVal: {
    flex: 1,
    fontSize: 12,
    color: premium.charcoalSoft,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    textAlign: "right",
  },
  totalPrice: {
    fontSize: 20,
    fontWeight: "800",
    color: premium.charcoal,
  },
  itemsHead: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.muted,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginTop: 8,
    marginBottom: 10,
  },
  items: { gap: 8, marginBottom: 16 },
  lineRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  lineQty: {
    fontSize: 15,
    fontWeight: "800",
    color: premium.kitchen,
    minWidth: 28,
  },
  line: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: premium.charcoal,
    fontWeight: "600",
  },
  primary: {
    backgroundColor: premium.kitchen,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryPressed: { opacity: 0.92 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "800" },
});
