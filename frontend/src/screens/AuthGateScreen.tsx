import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthStore } from "../store/authStore";
import { premium } from "../theme/premium";

const PIN_LENGTH = 4;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];

export function AuthGateScreen() {
  const insets = useSafeAreaInsets();
  const loginWithPin = useAuthStore((s) => s.loginWithPin);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);

  const submit = useCallback(
    (candidate: string) => {
      const role = loginWithPin(candidate);
      if (!role) {
        setError(true);
        setPin("");
      }
    },
    [loginWithPin]
  );

  const onKeyPress = useCallback(
    (key: string) => {
      if (key === "") return;
      setError(false);
      if (key === "del") {
        setPin((p) => p.slice(0, -1));
        return;
      }
      setPin((p) => {
        if (p.length >= PIN_LENGTH) return p;
        const next = p + key;
        if (next.length === PIN_LENGTH) {
          submit(next);
        }
        return next;
      });
    },
    [submit]
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.hero, { paddingTop: Math.max(insets.top, 12) }]}>
        <Text style={styles.kicker}>STAFF ACCESS</Text>
        <Text style={styles.brand}>SmartWaiter</Text>
        <View style={styles.goldRule} />
        <Text style={styles.tagline}>Enter your 4-digit staff PIN</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.dotsRow}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i < pin.length && styles.dotFilled,
                error && styles.dotError,
              ]}
            />
          ))}
        </View>
        {error ? (
          <Text style={styles.errorText}>Incorrect PIN — try again</Text>
        ) : (
          <Text style={styles.hintText}> </Text>
        )}

        <View style={styles.keypad}>
          {KEYS.map((key, i) => (
            <Pressable
              key={`${key}-${i}`}
              disabled={key === ""}
              accessibilityRole={key ? "button" : undefined}
              accessibilityLabel={
                key === "del" ? "Delete digit" : key ? `Digit ${key}` : undefined
              }
              onPress={() => onKeyPress(key)}
              style={({ pressed }) => [
                styles.key,
                key === "" && styles.keyHidden,
                pressed && key !== "" && styles.keyPressed,
              ]}
            >
              <Text style={styles.keyLabel}>{key === "del" ? "⌫" : key}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: premium.screen },
  hero: {
    backgroundColor: premium.navBar,
    paddingTop: 16,
    paddingBottom: 32,
    paddingHorizontal: 24,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  kicker: {
    color: premium.navAccent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 3,
    marginBottom: 10,
  },
  brand: {
    fontSize: 34,
    fontWeight: "800",
    color: premium.onNav,
    letterSpacing: -1,
  },
  goldRule: {
    width: 56,
    height: 3,
    backgroundColor: premium.goldBright,
    marginTop: 14,
    marginBottom: 14,
    borderRadius: 2,
  },
  tagline: {
    fontSize: 15,
    lineHeight: 22,
    color: "rgba(255,255,255,0.72)",
  },
  body: {
    flex: 1,
    alignItems: "center",
    paddingTop: 40,
    paddingHorizontal: 24,
  },
  dotsRow: {
    flexDirection: "row",
    gap: 18,
    marginBottom: 14,
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: premium.border,
    backgroundColor: premium.ivory,
  },
  dotFilled: {
    backgroundColor: premium.goldBright,
    borderColor: premium.goldBright,
  },
  dotError: {
    borderColor: "#DC2626",
  },
  errorText: {
    color: "#DC2626",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 8,
  },
  hintText: {
    fontSize: 14,
    marginBottom: 8,
  },
  keypad: {
    marginTop: 24,
    width: 280,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 16,
  },
  key: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: premium.ivory,
    borderWidth: 1,
    borderColor: premium.border,
  },
  keyHidden: {
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  keyPressed: {
    backgroundColor: premium.goldMuted,
    borderColor: premium.gold,
  },
  keyLabel: {
    fontSize: 26,
    fontWeight: "700",
    color: premium.charcoal,
  },
});
