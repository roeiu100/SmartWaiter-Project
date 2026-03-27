import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppNavigator } from "./src/navigation/AppNavigator";

/**
 * Root: SafeArea + navigation. Simulator state lives in Zustand (`src/simulator/simulatorStore.ts`).
 * REPLACE: add API client (fetch/axios), auth provider, WebSocket provider wrapping the tree.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppNavigator />
    </SafeAreaProvider>
  );
}
