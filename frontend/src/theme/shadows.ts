import { Platform, type ViewStyle } from "react-native";

/** Soft card elevation — works on iOS + Android */
export const shadowCard: ViewStyle =
  Platform.OS === "ios"
    ? {
        shadowColor: "#1a1208",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.07,
        shadowRadius: 12,
      }
    : { elevation: 4 };

export const shadowSoft: ViewStyle =
  Platform.OS === "ios"
    ? {
        shadowColor: "#1a1208",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 6,
      }
    : { elevation: 2 };
