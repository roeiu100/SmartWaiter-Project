import { useMemo } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { RootStackParamList } from "../navigation/AppNavigator";
import {
  getRunnerQueue,
  useSimulatorStore,
} from "../simulator/simulatorStore";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Runner">;

export function RunnerDashboardScreen(_props: Props) {
  const orders = useSimulatorStore((s) => s.orders);
  const ready = useMemo(() => getRunnerQueue(orders), [orders]);
  const markOrderServed = useSimulatorStore((s) => s.markOrderServed);

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
          Mark served after food is at the table.
        </Text>
      </View>

      {ready.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>◎</Text>
          <Text style={styles.emptyTitle}>No deliveries</Text>
          <Text style={styles.emptyText}>
            Orders appear when kitchen marks them ready
          </Text>
        </View>
      ) : (
        ready.map((order) => (
          <View key={order.id} style={styles.card}>
            <View style={styles.readyPill}>
              <Text style={styles.readyPillText}>Ready</Text>
            </View>

            <Text style={styles.deliverLabel}>Deliver to</Text>
            <Text style={styles.table}>{order.table_id}</Text>

            <View style={styles.divider} />

            <Text style={styles.meta} numberOfLines={1}>
              #{order.id.slice(-8)}
            </Text>

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
                styles.servedBtn,
                pressed && styles.servedBtnPressed,
              ]}
              onPress={() => markOrderServed(order.id)}
            >
              <Text style={styles.servedBtnText}>Mark as served</Text>
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
  meta: {
    fontSize: 12,
    color: premium.muted,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
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
  items: { gap: 8 },
  lineRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
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
});
