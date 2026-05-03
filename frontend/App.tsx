import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppNavigator } from "./src/navigation/AppNavigator";

/**
 * Root: GestureHandlerRootView (required by react-native-gesture-handler and
 * react-native-draggable-flatlist), SafeArea + navigation. Simulator state
 * lives in Zustand (`src/simulator/simulatorStore.ts`).
 * REPLACE: add API client (fetch/axios), auth provider, WebSocket provider
 * wrapping the tree.
 */
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
