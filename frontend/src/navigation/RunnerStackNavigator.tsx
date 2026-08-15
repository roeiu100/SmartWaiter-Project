import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text, View } from "react-native";
import { RunnerDashboardScreen } from "../screens/RunnerDashboardScreen";
import { TableMapScreen } from "../screens/TableMapScreen";
import { useAuthStore } from "../store/authStore";
import { premium } from "../theme/premium";
import type { RunnerStackParamList } from "./types";

const Stack = createNativeStackNavigator<RunnerStackParamList>();

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
 * Runner role only: the runner board plus the shared Table Map, mirroring
 * how ManagerStackNavigator wraps Manager + Analytics. Kitchen role never
 * sees this — StaffNavigator gives it a bare KitchenOnly screen instead.
 */
export function RunnerStackNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        ...darkHeader,
        contentStyle: { backgroundColor: premium.screen },
      }}
    >
      <Stack.Screen
        name="RunnerHome"
        component={RunnerDashboardScreen}
        options={({ navigation }) => ({
          title: "Runner",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open Table Map"
                onPress={() => navigation.navigate("TableMap")}
                hitSlop={8}
              >
                <Text
                  style={{ color: premium.navAccent, fontWeight: "700", fontSize: 13 }}
                >
                  Table Map
                </Text>
              </Pressable>
              <LogoutButton />
            </View>
          ),
        })}
      />
      <Stack.Screen
        name="TableMap"
        component={TableMapScreen}
        options={{ title: "Table Map" }}
      />
    </Stack.Navigator>
  );
}
