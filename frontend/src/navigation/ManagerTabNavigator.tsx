import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text } from "react-native";
import { ManagerScreen } from "../screens/ManagerScreen";
import { ManagerAnalyticsScreen } from "../screens/ManagerAnalyticsScreen";
import { KitchenDashboardScreen } from "../screens/KitchenDashboardScreen";
import { RunnerDashboardScreen } from "../screens/RunnerDashboardScreen";
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

/**
 * Manager role only: full access to Manager, Kitchen, and Runner boards via
 * tabs. Kitchen/Runner roles never see this navigator — they're routed
 * straight to their single board in StaffNavigator.
 */
export function ManagerTabNavigator() {
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
    </Tab.Navigator>
  );
}
