import { useEffect } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text } from "react-native";
import { io, type Socket } from "socket.io-client";
import { ManagerScreen } from "../screens/ManagerScreen";
import { ManagerAnalyticsScreen } from "../screens/ManagerAnalyticsScreen";
import { KitchenDashboardScreen } from "../screens/KitchenDashboardScreen";
import { RunnerDashboardScreen } from "../screens/RunnerDashboardScreen";
import { TableMapScreen } from "../screens/TableMapScreen";
import { MENU_API_BASE } from "../services/menuApi";
import { fetchUnpaidOrders } from "../services/orderApi";
import {
  usePendingCancellationsStore,
  type PendingCancellationItem,
} from "../store/pendingCancellationsStore";
import { useAuthStore } from "../store/authStore";
import { premium } from "../theme/premium";
import type { ManagerStackParamList, ManagerTabParamList } from "./types";

const Tab = createBottomTabNavigator<ManagerTabParamList>();
const ManagerStack = createNativeStackNavigator<ManagerStackParamList>();

const darkHeader = {
  headerStyle: { backgroundColor: premium.navBar },
  headerTintColor: premium.navAccent,
  headerTitleStyle: {
    fontWeight: "700" as const,
    fontSize: 17,
    color: premium.onNav,
    letterSpacing: 0.2,
  },
  headerShadowVisible: false,
};

function LogoutButton() {
  const logout = useAuthStore((s) => s.logout);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Log out"
      onPress={logout}
      hitSlop={8}
    >
      <Text style={{ color: premium.navAccent, fontWeight: "700", fontSize: 14 }}>
        Log out
      </Text>
    </Pressable>
  );
}

function ManagerStackNavigator() {
  return (
    <ManagerStack.Navigator
      screenOptions={{
        ...darkHeader,
        contentStyle: { backgroundColor: premium.screen },
        headerRight: () => <LogoutButton />,
      }}
    >
      <ManagerStack.Screen
        name="ManagerHome"
        component={ManagerScreen}
        options={{ title: "Manager" }}
      />
      <ManagerStack.Screen
        name="ManagerAnalytics"
        component={ManagerAnalyticsScreen}
        options={{ title: "Analytics" }}
      />
    </ManagerStack.Navigator>
  );
}

function pendingItemsFromUnpaidOrders(
  orders: Awaited<ReturnType<typeof fetchUnpaidOrders>>
): PendingCancellationItem[] {
  const out: PendingCancellationItem[] = [];
  for (const order of orders) {
    for (const it of order.items) {
      if (it.cancellation_status !== "requested") continue;
      out.push({
        order_id: order.id,
        item_id: it.id,
        table_id: order.table_id,
        menu_item_name: it.menu_item_name,
        quantity: it.quantity,
        reason: it.cancellation_reason ?? "",
        requested_at: it.canceled_at ?? order.created_at,
      });
    }
  }
  return out;
}

/**
 * Keeps `usePendingCancellationsStore` correct for the whole Manager session
 * regardless of which tab is focused (bottom-tab screens are lazy-mounted,
 * so TableMapScreen's own fetch wouldn't run until a manager opens Tables).
 * Mounted once at the tab-navigator level — this navigator is manager-only,
 * so runners never pick up this fetch/socket.
 */
function usePendingCancellationsSync() {
  const setItems = usePendingCancellationsStore((s) => s.setItems);
  const upsertItem = usePendingCancellationsStore((s) => s.upsertItem);
  const removeItem = usePendingCancellationsStore((s) => s.removeItem);

  useEffect(() => {
    let cancelled = false;
    void fetchUnpaidOrders()
      .then((orders) => {
        if (!cancelled) setItems(pendingItemsFromUnpaidOrders(orders));
      })
      .catch((err) => {
        console.warn("[ManagerTabNavigator] initial pending-cancellations fetch failed:", err);
      });

    const baseUrl = (MENU_API_BASE ?? "").toString().trim();
    if (!baseUrl) return () => { cancelled = true; };
    const socket: Socket = io(baseUrl, { transports: ["websocket", "polling"] });

    const onRequested = (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const r = data as Record<string, unknown>;
      const order_id = typeof r.order_id === "string" ? r.order_id : "";
      const item_id = typeof r.item_id === "string" ? r.item_id : "";
      const table_id = typeof r.table_id === "string" ? r.table_id : "";
      if (!order_id || !item_id || !table_id) return;
      upsertItem({
        order_id,
        item_id,
        table_id,
        menu_item_name: typeof r.menu_item_name === "string" ? r.menu_item_name : "",
        quantity: Number(r.quantity ?? 1),
        reason: typeof r.reason === "string" ? r.reason : "",
        requested_at:
          typeof r.requested_at === "string" ? r.requested_at : new Date().toISOString(),
      });
    };
    const onResolved = (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const r = data as Record<string, unknown>;
      const item_id = typeof r.item_id === "string" ? r.item_id : "";
      if (!item_id) return;
      removeItem(item_id);
    };

    socket.on("order_item_cancellation_requested", onRequested);
    socket.on("order_item_cancellation_resolved", onResolved);

    return () => {
      cancelled = true;
      socket.off("order_item_cancellation_requested", onRequested);
      socket.off("order_item_cancellation_resolved", onResolved);
      socket.disconnect();
    };
  }, [setItems, upsertItem, removeItem]);
}

/**
 * Manager role only: full access to Manager, Kitchen, and Runner boards via
 * tabs. Kitchen/Runner roles never see this navigator — they're routed
 * straight to their single board in StaffNavigator.
 */
export function ManagerTabNavigator() {
  usePendingCancellationsSync();
  const pendingCount = usePendingCancellationsStore((s) => s.items.length);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: premium.goldDark,
        tabBarInactiveTintColor: premium.muted,
        tabBarStyle: { backgroundColor: premium.ivory },
      }}
    >
      <Tab.Screen
        name="ManagerTab"
        component={ManagerStackNavigator}
        options={{ title: "Manager" }}
      />
      <Tab.Screen
        name="KitchenTab"
        component={KitchenDashboardScreen}
        options={{ title: "Kitchen" }}
      />
      <Tab.Screen
        name="RunnerTab"
        component={RunnerDashboardScreen}
        options={{ title: "Runner" }}
      />
      <Tab.Screen
        name="TablesTab"
        component={TableMapScreen}
        options={{
          title: "Tables",
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
        }}
      />
    </Tab.Navigator>
  );
}
