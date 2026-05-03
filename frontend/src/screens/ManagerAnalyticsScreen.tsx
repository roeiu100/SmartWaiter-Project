import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  BarChart,
  LineChart,
  type barDataItem,
  type lineDataItem,
} from "react-native-gifted-charts";
import type { RootStackParamList } from "../navigation/AppNavigator";
import {
  analyticsApi,
  type AnalyticsRange,
  type AnalyticsSummary,
  type OrdersByHour,
  type PrepTimesRow,
  type RevenueByDay,
  type TopDish,
} from "../services/analyticsApi";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "ManagerAnalytics">;

const AUTO_REFRESH_MS = 60_000;

type RangeKey = "today" | "7d" | "30d" | "custom";

interface RangePreset {
  key: RangeKey;
  label: string;
}

const PRESETS: RangePreset[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
];

function rangeForKey(key: RangeKey): AnalyticsRange {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  if (key === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (key === "7d") {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else {
    // 30d fallback (also for "custom" in this MVP where custom uses 30d default)
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (Math.abs(value) >= 10000) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(2)}`;
}

function formatMinutes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} min`;
}

function dayShortLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function ManagerAnalyticsScreen(_props: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const chartWidth = Math.max(280, Math.min(windowWidth - 48, 640));

  const [rangeKey, setRangeKey] = useState<RangeKey>("7d");
  const range = useMemo(() => rangeForKey(rangeKey), [rangeKey]);

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [revenue, setRevenue] = useState<RevenueByDay[]>([]);
  const [topDishes, setTopDishes] = useState<TopDish[]>([]);
  const [ordersByHour, setOrdersByHour] = useState<OrdersByHour[]>([]);
  const [prepTimes, setPrepTimes] = useState<PrepTimesRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dishesMetric, setDishesMetric] = useState<"revenue" | "units">(
    "revenue"
  );

  const fetchAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const [sum, rev, dishes, hours, prep] = await Promise.all([
          analyticsApi.summary(range),
          analyticsApi.revenueByDay(range),
          analyticsApi.topDishes(range, 10),
          analyticsApi.ordersByHour(range),
          analyticsApi.prepTimes(range),
        ]);
        setSummary(sum);
        setRevenue(rev);
        setTopDishes(dishes);
        setOrdersByHour(hours);
        setPrepTimes(prep);
      } catch (err) {
        console.warn("[ManagerAnalytics] fetch failed:", err);
        setError(
          err instanceof Error ? err.message : "Could not load analytics"
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [range]
  );

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Auto-refresh every AUTO_REFRESH_MS while the screen is focused.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useFocusEffect(
    useCallback(() => {
      intervalRef.current = setInterval(() => {
        void fetchAll({ silent: true });
      }, AUTO_REFRESH_MS);
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    }, [fetchAll])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll({ silent: true });
    setRefreshing(false);
  }, [fetchAll]);

  // --- Chart data transforms -----------------------------------------------

  const revenueLineData: lineDataItem[] = useMemo(
    () =>
      revenue.map((r) => ({
        value: r.revenue,
        label: dayShortLabel(r.day),
        dataPointText: r.revenue > 0 ? `$${Math.round(r.revenue)}` : "",
      })),
    [revenue]
  );

  const maxDishValue = useMemo(() => {
    if (topDishes.length === 0) return 0;
    return Math.max(
      ...topDishes.map((d) =>
        dishesMetric === "revenue" ? d.revenue : d.units
      )
    );
  }, [topDishes, dishesMetric]);

  const dishesBarData: barDataItem[] = useMemo(
    () =>
      topDishes.map((d) => ({
        value: dishesMetric === "revenue" ? d.revenue : d.units,
        label:
          d.name.length > 10 ? `${d.name.slice(0, 9)}…` : d.name || "(none)",
        topLabelComponent: () => (
          <Text style={styles.barTopLabel}>
            {dishesMetric === "revenue"
              ? `$${Math.round(d.revenue)}`
              : d.units}
          </Text>
        ),
        frontColor: premium.gold,
      })),
    [topDishes, dishesMetric]
  );

  const ordersHourData: barDataItem[] = useMemo(
    () =>
      ordersByHour.map((h) => ({
        value: h.orders,
        label: h.hour % 3 === 0 ? `${h.hour}` : "",
        frontColor: premium.manager,
      })),
    [ordersByHour]
  );

  const prepPairs = useMemo(() => {
    const prep: lineDataItem[] = [];
    const delivery: lineDataItem[] = [];
    for (const row of prepTimes) {
      prep.push({
        value: row.avg_prep_minutes ?? 0,
        label: dayShortLabel(row.day),
      });
      delivery.push({
        value: row.avg_delivery_minutes ?? 0,
        label: dayShortLabel(row.day),
      });
    }
    return { prep, delivery };
  }, [prepTimes]);

  // --- Render --------------------------------------------------------------

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={premium.gold}
        />
      }
    >
      <View style={styles.heroBlock}>
        <Text style={styles.kicker}>INSIGHTS</Text>
        <Text style={styles.heroTitle}>Manager analytics</Text>
        <Text style={styles.heroSub}>
          Revenue, demand, and prep times for your restaurant
        </Text>
      </View>

      <View style={styles.rangePills}>
        {PRESETS.map((p) => {
          const active = rangeKey === p.key;
          return (
            <Pressable
              key={p.key}
              onPress={() => setRangeKey(p.key)}
              style={({ pressed }) => [
                styles.rangePill,
                active && styles.rangePillActive,
                pressed && styles.rangePillPressed,
              ]}
            >
              <Text
                style={[
                  styles.rangePillLabel,
                  active && styles.rangePillLabelActive,
                ]}
              >
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading && !summary ? (
        <View style={styles.loadingBlock}>
          <ActivityIndicator size="large" color={premium.gold} />
          <Text style={styles.loadingText}>Loading analytics…</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void fetchAll()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {summary ? (
        <View style={styles.kpiGrid}>
          <KpiCard
            label="Revenue"
            value={formatCurrency(summary.revenue)}
            accent={premium.gold}
          />
          <KpiCard
            label="Orders"
            value={String(summary.orders_count)}
            accent={premium.manager}
          />
          <KpiCard
            label="Avg order"
            value={formatCurrency(summary.avg_order_value)}
            accent={premium.runner}
          />
          <KpiCard
            label="Avg prep"
            value={formatMinutes(summary.avg_prep_minutes)}
            accent={premium.kitchen}
          />
        </View>
      ) : null}

      {!loading && summary && summary.orders_count === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>◇</Text>
          <Text style={styles.emptyTitle}>No orders yet</Text>
          <Text style={styles.emptyText}>
            Charts will fill as orders come in.
          </Text>
        </View>
      ) : null}

      {revenueLineData.length > 0 ? (
        <Section title="Revenue by day">
          <LineChart
            data={revenueLineData}
            width={chartWidth}
            height={200}
            spacing={Math.max(32, chartWidth / Math.max(6, revenueLineData.length))}
            color={premium.gold}
            thickness={3}
            dataPointsColor={premium.goldDark}
            curved
            yAxisColor={premium.border}
            xAxisColor={premium.border}
            yAxisTextStyle={styles.axisText}
            xAxisLabelTextStyle={styles.axisText}
            rulesColor="#EEE9E0"
            noOfSections={4}
            initialSpacing={12}
            endSpacing={12}
          />
        </Section>
      ) : null}

      {topDishes.length > 0 ? (
        <Section
          title="Top dishes"
          actionLabel={dishesMetric === "revenue" ? "Show units" : "Show revenue"}
          onAction={() =>
            setDishesMetric((m) => (m === "revenue" ? "units" : "revenue"))
          }
        >
          <BarChart
            data={dishesBarData}
            width={chartWidth}
            height={220}
            barWidth={Math.max(16, chartWidth / (topDishes.length * 2.5))}
            spacing={12}
            initialSpacing={10}
            noOfSections={4}
            maxValue={Math.max(maxDishValue * 1.2, 1)}
            yAxisColor={premium.border}
            xAxisColor={premium.border}
            yAxisTextStyle={styles.axisText}
            xAxisLabelTextStyle={styles.axisTextSmall}
            rulesColor="#EEE9E0"
            frontColor={premium.gold}
            isAnimated
          />
        </Section>
      ) : null}

      {ordersByHour.some((h) => h.orders > 0) ? (
        <Section title="Orders by hour">
          <BarChart
            data={ordersHourData}
            width={chartWidth}
            height={180}
            barWidth={Math.max(6, chartWidth / 30)}
            spacing={Math.max(2, chartWidth / 160)}
            initialSpacing={8}
            noOfSections={4}
            yAxisColor={premium.border}
            xAxisColor={premium.border}
            yAxisTextStyle={styles.axisText}
            xAxisLabelTextStyle={styles.axisTextSmall}
            rulesColor="#EEE9E0"
            frontColor={premium.manager}
            isAnimated
          />
        </Section>
      ) : null}

      {prepPairs.prep.length > 0 ? (
        <Section title="Prep vs delivery (minutes)">
          <LineChart
            data={prepPairs.prep}
            data2={prepPairs.delivery}
            width={chartWidth}
            height={200}
            spacing={Math.max(32, chartWidth / Math.max(6, prepPairs.prep.length))}
            color={premium.kitchen}
            color2={premium.runner}
            thickness={3}
            thickness2={3}
            dataPointsColor={premium.kitchen}
            dataPointsColor2={premium.runner}
            yAxisColor={premium.border}
            xAxisColor={premium.border}
            yAxisTextStyle={styles.axisText}
            xAxisLabelTextStyle={styles.axisText}
            rulesColor="#EEE9E0"
            noOfSections={4}
            initialSpacing={12}
            endSpacing={12}
          />
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View
                style={[styles.legendDot, { backgroundColor: premium.kitchen }]}
              />
              <Text style={styles.legendLabel}>Prep</Text>
            </View>
            <View style={styles.legendItem}>
              <View
                style={[styles.legendDot, { backgroundColor: premium.runner }]}
              />
              <Text style={styles.legendLabel}>Delivery</Text>
            </View>
          </View>
        </Section>
      ) : null}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KpiCard(props: { label: string; value: string; accent: string }) {
  return (
    <View style={[styles.kpiCard, { borderLeftColor: props.accent }]}>
      <Text style={styles.kpiLabel}>{props.label}</Text>
      <Text style={styles.kpiValue}>{props.value}</Text>
    </View>
  );
}

function Section(props: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{props.title}</Text>
        {props.actionLabel && props.onAction ? (
          <Pressable
            onPress={props.onAction}
            style={({ pressed }) => [
              styles.sectionAction,
              pressed && styles.sectionActionPressed,
            ]}
          >
            <Text style={styles.sectionActionLabel}>{props.actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.chartHost}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: premium.screen },
  container: {
    padding: 20,
    paddingBottom: 48,
    gap: 18,
  },
  heroBlock: { marginBottom: 4 },
  kicker: {
    fontSize: 11,
    fontWeight: "800",
    color: premium.goldDark,
    letterSpacing: 2.5,
    marginBottom: 6,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.5,
  },
  heroSub: {
    fontSize: 14,
    color: premium.charcoalSoft,
    marginTop: 6,
  },
  rangePills: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  rangePill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: premium.ivory,
    borderWidth: 1,
    borderColor: premium.border,
  },
  rangePillActive: {
    backgroundColor: premium.charcoal,
    borderColor: premium.charcoal,
  },
  rangePillPressed: { opacity: 0.85 },
  rangePillLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: premium.charcoalSoft,
  },
  rangePillLabelActive: { color: "#fff" },
  loadingBlock: {
    paddingVertical: 32,
    alignItems: "center",
    gap: 10,
  },
  loadingText: { color: premium.muted, fontSize: 13 },
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
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  kpiCard: {
    flexGrow: 1,
    flexBasis: "45%",
    minWidth: 140,
    backgroundColor: premium.ivory,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: premium.border,
    borderLeftWidth: 4,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: premium.muted,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.3,
  },
  empty: {
    paddingVertical: 40,
    paddingHorizontal: 24,
    backgroundColor: premium.ivory,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: premium.border,
    alignItems: "center",
  },
  emptyIcon: { fontSize: 26, color: premium.mutedLight, marginBottom: 6 },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: premium.charcoal,
    marginBottom: 4,
  },
  emptyText: { color: premium.muted, fontSize: 13, textAlign: "center" },
  section: {
    backgroundColor: premium.ivory,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: premium.border,
    gap: 12,
  },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.2,
  },
  sectionAction: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: premium.ivoryDark,
    borderWidth: 1,
    borderColor: premium.border,
  },
  sectionActionPressed: { opacity: 0.8 },
  sectionActionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: premium.charcoalSoft,
  },
  chartHost: {
    alignItems: "center",
    overflow: "hidden",
    paddingVertical: 4,
  },
  axisText: { color: premium.muted, fontSize: 10 },
  axisTextSmall: { color: premium.muted, fontSize: 9 },
  barTopLabel: {
    color: premium.charcoalSoft,
    fontSize: 10,
    fontWeight: "700",
    marginBottom: 2,
  },
  legendRow: {
    flexDirection: "row",
    gap: 14,
    justifyContent: "center",
    marginTop: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: premium.charcoalSoft,
  },
});
