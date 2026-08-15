import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text } from "react-native";
import { AuthGateScreen } from "../screens/AuthGateScreen";
import { KitchenDashboardScreen } from "../screens/KitchenDashboardScreen";
import { RunnerStackNavigator } from "./RunnerStackNavigator";
import { ManagerTabNavigator } from "./ManagerTabNavigator";
import { useAuthStore } from "../store/authStore";
import { premium } from "../theme/premium";
import type { StaffStackParamList } from "./types";

const Stack = createNativeStackNavigator<StaffStackParamList>();

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

/**
 * Staff entry point. Renders a DIFFERENT set of screens depending on
 * `authStore.role` (the React Navigation "auth flow" pattern) — swapping the
 * screen set resets navigation state automatically, so logging out always
 * lands back on the PIN pad with no leftover history.
 *
 * Kitchen/Runner roles only ever see their own board: there is no
 * Stack.Screen registered for the other boards while that role is active,
 * so there is no route to navigate to even if a component tried.
 */
export function StaffNavigator() {
  const role = useAuthStore((s) => s.role);

  return (
    <Stack.Navigator
      screenOptions={{
        ...darkHeader,
        contentStyle: { backgroundColor: premium.screen },
      }}
    >
      {role === null ? (
        <Stack.Screen
          name="AuthGate"
          component={AuthGateScreen}
          options={{ headerShown: false }}
        />
      ) : role === "kitchen" ? (
        <Stack.Screen
          name="KitchenOnly"
          component={KitchenDashboardScreen}
          options={{ title: "Kitchen", headerRight: () => <LogoutButton /> }}
        />
      ) : role === "runner" ? (
        <Stack.Screen
          name="RunnerOnly"
          component={RunnerStackNavigator}
          options={{ headerShown: false }}
        />
      ) : (
        <Stack.Screen
          name="ManagerTabs"
          component={ManagerTabNavigator}
          options={{ headerShown: false }}
        />
      )}
    </Stack.Navigator>
  );
}
