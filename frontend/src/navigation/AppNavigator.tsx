import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RoleSelectionScreen } from "../screens/RoleSelectionScreen";
import { GuestMenuScreen } from "../screens/GuestMenuScreen";
import { KitchenDashboardScreen } from "../screens/KitchenDashboardScreen";
import { RunnerDashboardScreen } from "../screens/RunnerDashboardScreen";
import { ManagerScreen } from "../screens/ManagerScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { premium } from "../theme/premium";

export type RootStackParamList = {
  RoleSelection: undefined;
  Guest: undefined;
  Kitchen: undefined;
  Runner: undefined;
  Manager: undefined;
  Chat: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

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
  headerBackTitleVisible: false,
};

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="RoleSelection"
        screenOptions={{
          ...darkHeader,
          contentStyle: { backgroundColor: premium.screen },
        }}
      >
        <Stack.Screen
          name="RoleSelection"
          component={RoleSelectionScreen}
          options={{
            title: "",
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="Guest"
          component={GuestMenuScreen}
          options={{ title: "Order" }}
        />
        <Stack.Screen
          name="Kitchen"
          component={KitchenDashboardScreen}
          options={{ title: "Kitchen" }}
        />
        <Stack.Screen
          name="Runner"
          component={RunnerDashboardScreen}
          options={{ title: "Runner" }}
        />
        <Stack.Screen
          name="Manager"
          component={ManagerScreen}
          options={{ title: "Manager" }}
        />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={{ title: "AI Waiter" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
