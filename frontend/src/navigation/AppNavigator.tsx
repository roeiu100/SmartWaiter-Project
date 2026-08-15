import * as Linking from "expo-linking";
import {
  NavigationContainer,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { CustomerNavigator } from "./CustomerNavigator";
import { StaffNavigator } from "./StaffNavigator";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * A `smartwaiter://table/5` (or `exp://.../--/table/5` in Expo Go) link opens
 * the app straight into CustomerFlow > Chat (the AI Waiter) with
 * `tableId: "5"` in the route params — see the effect in ChatScreen that
 * pins it into `simulatorStore`. Any URL that does NOT match
 * `table/:tableId` (including just opening the app normally) falls through
 * to the default `initialRouteName="Staff"` below, landing on the PIN Auth
 * Gate.
 */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [Linking.createURL("/"), "smartwaiter://"],
  config: {
    screens: {
      Customer: {
        screens: {
          Chat: "table/:tableId",
        },
      },
      Staff: "staff",
    },
  },
};

export function AppNavigator() {
  return (
    <NavigationContainer linking={linking}>
      <Stack.Navigator
        initialRouteName="Staff"
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="Customer" component={CustomerNavigator} />
        <Stack.Screen name="Staff" component={StaffNavigator} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
