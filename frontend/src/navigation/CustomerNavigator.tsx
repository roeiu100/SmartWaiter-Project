import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text } from "react-native";
import { GuestMenuScreen } from "../screens/GuestMenuScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { premium } from "../theme/premium";
import type { CustomerStackParamList } from "./types";

const Stack = createNativeStackNavigator<CustomerStackParamList>();

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

/**
 * Guest-facing flow only: table ordering + AI waiter chat. Has no route to
 * StaffFlow — the only way into staff screens is the separate AuthGate.
 */
export function CustomerNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Guest"
      screenOptions={{
        ...darkHeader,
        contentStyle: { backgroundColor: premium.screen },
      }}
    >
      <Stack.Screen
        name="Guest"
        component={GuestMenuScreen}
        options={({ navigation }) => ({
          title: "Order",
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Chat with AI Waiter"
              onPress={() => navigation.navigate("Chat")}
              hitSlop={8}
            >
              <Text
                style={{
                  color: premium.navAccent,
                  fontWeight: "700",
                  fontSize: 14,
                }}
              >
                AI Waiter
              </Text>
            </Pressable>
          ),
        })}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: "AI Waiter" }}
      />
    </Stack.Navigator>
  );
}
