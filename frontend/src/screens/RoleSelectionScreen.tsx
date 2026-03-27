import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "RoleSelection">;

const ROLES = [
  {
    key: "Guest" as const,
    title: "Guest",
    hint: "Browse the menu & order",
    route: "Guest" as const,
    accent: premium.goldBright,
  },
  {
    key: "Kitchen" as const,
    title: "Kitchen",
    hint: "Tickets & prep",
    route: "Kitchen" as const,
    accent: premium.kitchen,
  },
  {
    key: "Runner" as const,
    title: "Runner",
    hint: "Deliver to tables",
    route: "Runner" as const,
    accent: premium.runner,
  },
  {
    key: "Manager" as const,
    title: "Manager",
    hint: "Menu availability & settings",
    route: "Manager" as const,
    accent: premium.manager,
  },
];

export function RoleSelectionScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <View style={[styles.hero, { paddingTop: Math.max(insets.top, 12) }]}>
        <Text style={styles.kicker}>SIMULATOR</Text>
        <Text style={styles.brand}>SmartWaiter</Text>
        <View style={styles.goldRule} />
        <Text style={styles.tagline}>
          Select a role to run the full service flow
        </Text>
      </View>

      <View style={styles.list}>
        {ROLES.map((role) => (
          <Pressable
            key={role.key}
            accessibilityRole="button"
            accessibilityLabel={role.title}
            style={({ pressed }) => [
              styles.card,
              pressed && styles.cardPressed,
            ]}
            onPress={() => navigation.navigate(role.route)}
          >
            <View style={[styles.accentBar, { backgroundColor: role.accent }]} />
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle}>{role.title}</Text>
              <Text style={styles.cardHint}>{role.hint}</Text>
            </View>
            <Text style={[styles.arrow, { color: role.accent }]}>›</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: premium.screen,
  },
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
    maxWidth: 300,
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 14,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: premium.ivory,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: premium.border,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  cardPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.99 }],
  },
  accentBar: {
    width: 5,
    alignSelf: "stretch",
    minHeight: 88,
  },
  cardBody: {
    flex: 1,
    paddingVertical: 18,
    paddingHorizontal: 16,
    gap: 6,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: -0.4,
  },
  cardHint: {
    fontSize: 14,
    color: premium.charcoalSoft,
    lineHeight: 20,
  },
  arrow: {
    fontSize: 32,
    fontWeight: "300",
    paddingRight: 14,
    marginTop: -4,
  },
});
