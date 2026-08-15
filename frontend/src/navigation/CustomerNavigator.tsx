import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text, View } from "react-native";
import { GuestMenuScreen } from "../screens/GuestMenuScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { BillScreen } from "../screens/BillScreen";
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

function HeaderNavButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
    >
      <Text style={{ color: premium.navAccent, fontWeight: "700", fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Guest-facing flow only: table ordering + AI waiter chat + bill. Has no
 * route to StaffFlow — the only way into staff screens is the separate
 * AuthGate. AI Waiter chat is the default/deep-link screen; the manual menu
 * and the bill are reachable via header buttons from either screen (Bill is
 * also reachable via the AI's `request_check` tool call).
 */
export function CustomerNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Chat"
      screenOptions={{
        ...darkHeader,
        contentStyle: { backgroundColor: premium.screen },
      }}
    >
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={({ navigation }) => ({
          title: "AI Waiter",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
              <HeaderNavButton
                label="Browse Menu"
                onPress={() => navigation.navigate("Guest")}
              />
              <HeaderNavButton
                label="Ask for Check"
                onPress={() => navigation.navigate("Bill")}
              />
            </View>
          ),
        })}
      />
      <Stack.Screen
        name="Guest"
        component={GuestMenuScreen}
        options={({ navigation }) => ({
          title: "Order",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
              <HeaderNavButton
                label="AI Waiter"
                onPress={() => navigation.navigate("Chat")}
              />
              <HeaderNavButton
                label="Ask for Check"
                onPress={() => navigation.navigate("Bill")}
              />
            </View>
          ),
        })}
      />
      <Stack.Screen
        name="Bill"
        component={BillScreen}
        options={{ title: "Your Bill" }}
      />
    </Stack.Navigator>
  );
}
