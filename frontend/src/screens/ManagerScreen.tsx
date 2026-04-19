import { useCallback, useEffect, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { fetchMenuFromApi, MENU_API_BASE } from "../services/menuApi";
import type { MenuItemRow } from "../types/database";
import { premium } from "../theme/premium";

type Props = NativeStackScreenProps<RootStackParamList, "Manager">;

/**
 * Menu API base is shared with the guest menu (`MENU_API_BASE` in `menuApi.ts`).
 * Update that constant if your computer’s LAN IP changes (currently the dev machine IP).
 */
export function ManagerScreen(_props: Props) {
  const [menuItems, setMenuItems] = useState<MenuItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMenu = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMenuFromApi();
      setMenuItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load menu");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMenu();
  }, [loadMenu]);

  const toggleAvailability = useCallback(
    async (id: string, currentStatus: boolean) => {
      const newStatus = !currentStatus;
      try {
        const url = `${MENU_API_BASE}/api/menu/${encodeURIComponent(id)}/availability`;
        console.log('Toggling item ID:', id, 'at URL:', url);
        const res = await fetch(url, {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ is_available: newStatus }),
        });

        if (!res.ok) {
          const text = await res.text();
          console.error(
            "[Manager] toggleAvailability failed",
            res.status,
            text.slice(0, 200)
          );
          return;
        }

        const data = (await res.json()) as {
          menu_item_id: string;
          is_available: boolean;
        };

        setMenuItems((prev) =>
          prev.map((item) =>
            item.id === data.menu_item_id
              ? { ...item, is_available: data.is_available }
              : item
          )
        );
      } catch (err) {
        console.error("[Manager] toggleAvailability network error", err);
      }
    },
    []
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={premium.manager} />
        <Text style={styles.hint}>Loading menu…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
        <Text style={styles.apiHint}>
          API: {MENU_API_BASE}/api/menu
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.subhead}>
        Toggle availability — updates save to the server when the request succeeds.
      </Text>
      <FlatList
        data={menuItems}
        keyExtractor={(item) => item.id}
        extraData={menuItems}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>
                {item.category} · ${item.price.toFixed(2)}
              </Text>
            </View>
            <Switch
              value={item.is_available}
              onValueChange={() =>
                toggleAvailability(item.id, item.is_available)
              }
              trackColor={{
                false: premium.border,
                true: "rgba(99, 102, 241, 0.35)",
              }}
              thumbColor={item.is_available ? premium.manager : premium.mutedLight}
              ios_backgroundColor={premium.border}
            />
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No menu items returned.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: premium.screen,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: premium.screen,
    gap: 12,
  },
  hint: { fontSize: 15, color: premium.muted },
  error: {
    fontSize: 15,
    color: "#B91C1C",
    textAlign: "center",
    lineHeight: 22,
  },
  apiHint: {
    fontSize: 12,
    color: premium.muted,
    textAlign: "center",
  },
  subhead: {
    fontSize: 13,
    color: premium.charcoalSoft,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
    lineHeight: 18,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    backgroundColor: premium.ivory,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: premium.border,
  },
  rowMain: { flex: 1, minWidth: 0 },
  name: {
    fontSize: 17,
    fontWeight: "700",
    color: premium.charcoal,
    marginBottom: 4,
  },
  meta: {
    fontSize: 13,
    color: premium.muted,
  },
  empty: {
    textAlign: "center",
    color: premium.muted,
    marginTop: 24,
    fontSize: 15,
  },
});
