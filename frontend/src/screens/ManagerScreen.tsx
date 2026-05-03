import { useCallback, useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from "react-native";
import type { RootStackParamList } from "../navigation/AppNavigator";
import {
  createMenuItem,
  createRunnerOption,
  deleteMenuItem,
  deleteRunnerOption,
  fetchMenuFromApi,
  fetchRunnerOptionsFromApi,
  MENU_API_BASE,
  updateMenuItem,
  updateRunnerOptionAvailability,
} from "../services/menuApi";
import type { MenuItemRow, RunnerOptionRow } from "../types/database";
import { premium } from "../theme/premium";
import {
  useManagerAlertsStore,
  type ManagerAlert,
} from "../store/managerAlertsStore";

/**
 * Shared Manager socket. Cached on globalThis so that Metro Fast Refresh
 * re-evaluating this module does NOT create a new socket each time (which
 * would leave ghost sockets behind and cause duplicate `new_manager_alert`
 * deliveries). The connection and its listeners are created exactly once
 * per app session.
 */
const MANAGER_SOCKET_URL = (MENU_API_BASE ?? "").toString().trim();

interface ManagerSocketGlobal {
  __managerSocket?: Socket;
  __managerSocketListenersAttached?: boolean;
}
const g = globalThis as unknown as ManagerSocketGlobal;

function createAndWireManagerSocket(): Socket {
  const s = io(MANAGER_SOCKET_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    autoConnect: true,
    forceNew: false,
  });

  s.on("connect", () => {
    console.log(
      "[Manager] socket connected:",
      s.id,
      "->",
      MANAGER_SOCKET_URL
    );
  });
  s.on("connect_error", (err: Error) => {
    console.warn("[Manager] socket connect_error:", err?.message ?? err);
  });
  s.on("disconnect", (reason: string) => {
    console.log("[Manager] socket disconnected:", reason);
  });
  // Debug-only: prove events arrive at the transport. Safe to remove later.
  s.onAny((event, ...args) => {
    console.log("[Manager] socket event:", event, args);
  });

  if (MANAGER_SOCKET_URL) {
    s.on("new_manager_alert", (data: unknown) => {
      console.log("[Manager] Alert received:", data);
      if (!data || typeof data !== "object") return;
      const { table, reason, time } = data as {
        table?: unknown;
        reason?: unknown;
        time?: unknown;
      };
      const safeTable =
        typeof table === "string" ? table : String(table ?? "");
      const safeReason = typeof reason === "string" ? reason : "";
      const safeTime =
        typeof time === "string" ? time : new Date().toISOString();
      if (!safeTable) return;
      const alert: ManagerAlert = {
        id: `${safeTable}|${safeTime}|${Math.random().toString(36).slice(2, 8)}`,
        table: safeTable,
        reason: safeReason,
        time: safeTime,
      };
      useManagerAlertsStore.getState().addAlert(alert);
    });

    s.on("blocked_tables_updated", (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const { tables } = data as { tables?: unknown };
      const list = Array.isArray(tables)
        ? tables.map((t) => String(t ?? "")).filter((t) => t.length > 0)
        : [];
      console.log("[Manager] Blocked tables updated:", list);
      useManagerAlertsStore.getState().setBlockedTables(list);
    });
  } else {
    console.warn(
      "[Manager] MENU_API_BASE is not set; Socket.io disabled for this screen"
    );
  }

  return s;
}

if (!g.__managerSocket) {
  g.__managerSocket = createAndWireManagerSocket();
  g.__managerSocketListenersAttached = true;
}
export const socket: Socket = g.__managerSocket;

function formatAlertTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function showToast(message: string) {
  if (Platform.OS === "android") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert("", message);
  }
}

type Props = NativeStackScreenProps<RootStackParamList, "Manager">;

/**
 * Menu API base is shared with the guest menu (`MENU_API_BASE` in `menuApi.ts`).
 * Update that constant if your computer’s LAN IP changes (currently the dev machine IP).
 */
export function ManagerScreen({ navigation }: Props) {
  const [menuItems, setMenuItems] = useState<MenuItemRow[]>([]);
  const [runnerOptions, setRunnerOptions] = useState<RunnerOptionRow[]>([]);
  const [newRunnerOptionName, setNewRunnerOptionName] = useState("");
  const [addingRunnerOption, setAddingRunnerOption] = useState(false);

  // Which category dropdowns are currently expanded in the menu editor.
  // Keyed by a normalized (lowercased) category name so header taps match
  // the same key regardless of casing variations coming from the DB.
  const [expandedCategories, setExpandedCategories] = useState<
    Record<string, boolean>
  >({});
  const toggleCategoryExpanded = useCallback((key: string) => {
    setExpandedCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // "Add / Edit dish" modal state. The price/allergens/ingredients inputs
  // stay as strings until save so the user can type freely (parsed on submit).
  // `editingDishId` is null for create-mode, or the id of the dish being
  // edited for update-mode.
  const [isDishModalVisible, setIsDishModalVisible] = useState(false);
  const [editingDishId, setEditingDishId] = useState<string | null>(null);
  const [newDishName, setNewDishName] = useState("");
  const [newDishDescription, setNewDishDescription] = useState("");
  const [newDishPrice, setNewDishPrice] = useState("");
  const [newDishCategory, setNewDishCategory] = useState("");
  const [newDishAllergens, setNewDishAllergens] = useState("");
  const [newDishIngredients, setNewDishIngredients] = useState("");
  const [savingDish, setSavingDish] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const managerAlerts = useManagerAlertsStore((s) => s.alerts);
  const removeAlertByTable = useManagerAlertsStore((s) => s.removeByTable);
  const blockedTables = useManagerAlertsStore((s) => s.blockedTables);

  const loadMenu = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;

    
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      // Menu load is the primary fetch; if it fails we show the error screen.
      // Runner options are secondary — a failure there shouldn't block menu
      // management, so we log and keep going.
      const [menuData, runnerResult] = await Promise.all([
        fetchMenuFromApi(),
        fetchRunnerOptionsFromApi().catch((err) => {
          console.warn("[Manager] Runner options fetch failed:", err);
          return null;
        }),
      ]);
      setMenuItems(menuData);
      if (runnerResult) {
        setRunnerOptions(runnerResult);
      }
      if (silent) {
        setError(null);
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not load menu";
      if (silent) {
        console.warn("[Manager] Silent menu refresh failed:", message);
      } else {
        setError(message);
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  // Menu sync listener — module-scope new_manager_alert handler lives above
  // the component; this effect only attaches the menu refresh listener.
  useEffect(() => {
    if (!MANAGER_SOCKET_URL) return;

    const onMenuUpdated = () => {
      void loadMenu({ silent: true });
    };
    socket.on("menu_updated", onMenuUpdated);
    return () => {
      socket.off("menu_updated", onMenuUpdated);
    };
  }, [loadMenu]);

  const onBlockTable = useCallback(
    (table: string) => {
      socket.emit("block_table", { table });
      removeAlertByTable(table);
      showToast(`Table ${table} blocked from manager alerts`);
    },
    [removeAlertByTable]
  );

  const onUnblockTable = useCallback((table: string) => {
    socket.emit("unblock_table", { table });
    // Optimistic: server will follow up with blocked_tables_updated, but we
    // remove it locally right away so the UI feels instant.
    useManagerAlertsStore
      .getState()
      .setBlockedTables(
        useManagerAlertsStore
          .getState()
          .blockedTables.filter((t) => t !== table)
      );
    showToast(`Table ${table} unblocked`);
  }, []);

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

  const resetDishForm = useCallback(() => {
    setNewDishName("");
    setNewDishDescription("");
    setNewDishPrice("");
    setNewDishCategory("");
    setNewDishAllergens("");
    setNewDishIngredients("");
    setEditingDishId(null);
  }, []);

  const closeDishModal = useCallback(() => {
    setIsDishModalVisible(false);
    resetDishForm();
  }, [resetDishForm]);

  const openAddDishModal = useCallback(() => {
    resetDishForm();
    setIsDishModalVisible(true);
  }, [resetDishForm]);

  const openEditDishModal = useCallback((dish: MenuItemRow) => {
    setEditingDishId(dish.id);
    setNewDishName(dish.name ?? "");
    setNewDishDescription(dish.description ?? "");
    setNewDishPrice(
      Number.isFinite(dish.price) ? String(dish.price) : ""
    );
    setNewDishCategory(dish.category ?? "");

    const meta = dish.metadata ?? {};
    const allergensRaw = (meta as Record<string, unknown>).allergens;
    const ingredientsRaw = (meta as Record<string, unknown>).ingredients;

    const allergens = Array.isArray(allergensRaw)
      ? allergensRaw.filter((v): v is string => typeof v === "string")
      : [];
    const ingredients = Array.isArray(ingredientsRaw)
      ? ingredientsRaw.filter((v): v is string => typeof v === "string")
      : [];

    setNewDishAllergens(allergens.join(", "));
    setNewDishIngredients(ingredients.join(", "));
    setIsDishModalVisible(true);
  }, []);

  const deleteDish = useCallback(
    (id: string, name: string) => {
      Alert.alert(
        "Delete dish",
        `Are you sure you want to delete "${name}"?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              const snapshot = menuItems;
              setMenuItems((prev) => prev.filter((m) => m.id !== id));
              try {
                await deleteMenuItem(id);
                showToast(`${name} removed from the menu`);
              } catch (err) {
                console.error("[Manager] deleteDish failed", err);
                setMenuItems(snapshot);
                Alert.alert(
                  "Delete failed",
                  err instanceof Error && err.message
                    ? err.message
                    : "Could not delete the dish."
                );
              }
            },
          },
        ]
      );
    },
    [menuItems]
  );

  const saveNewDish = useCallback(async () => {
    const name = newDishName.trim();
    const category = newDishCategory.trim();
    const priceNum = Number.parseFloat(newDishPrice.replace(",", "."));

    if (!name) {
      Alert.alert("Missing name", "Please enter a dish name.");
      return;
    }
    if (!category) {
      Alert.alert("Missing category", "Please enter a category (e.g. food).");
      return;
    }
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      Alert.alert("Invalid price", "Please enter a valid non-negative price.");
      return;
    }

    // "dairy, nuts , soy" -> ["dairy", "nuts", "soy"]
    const allergens = newDishAllergens
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const ingredientsArray = newDishIngredients
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const description = newDishDescription.trim();

    // Only attach metadata when there's actually something to store so we
    // don't persist empty arrays for dishes without allergens/ingredients.
    const metadata: Record<string, unknown> | undefined =
      allergens.length > 0 || ingredientsArray.length > 0
        ? {
            ...(allergens.length > 0 ? { allergens } : {}),
            ...(ingredientsArray.length > 0
              ? { ingredients: ingredientsArray }
              : {}),
          }
        : undefined;

    setSavingDish(true);
    try {
      if (editingDishId) {
        // Edit mode: send explicit `null` for metadata so empty forms
        // clear the column rather than leaving stale values in place.
        const updated = await updateMenuItem(editingDishId, {
          name,
          description: description.length > 0 ? description : null,
          price: priceNum,
          category: category.toLowerCase(),
          metadata: metadata ?? null,
        });
        setMenuItems((prev) =>
          prev.map((m) => (m.id === updated.id ? updated : m))
        );
        closeDishModal();
        showToast(`${updated.name} updated`);
      } else {
        const created = await createMenuItem({
          name,
          description: description.length > 0 ? description : null,
          price: priceNum,
          category: category.toLowerCase(),
          is_available: true,
          metadata,
        });
        setMenuItems((prev) => [...prev, created]);
        closeDishModal();
        showToast(`${created.name} added to the menu`);
      }
    } catch (err) {
      console.error("[Manager] saveNewDish failed", err);
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not save the dish";
      Alert.alert("Save failed", msg);
    } finally {
      setSavingDish(false);
    }
  }, [
    closeDishModal,
    editingDishId,
    newDishAllergens,
    newDishCategory,
    newDishDescription,
    newDishIngredients,
    newDishName,
    newDishPrice,
  ]);

  const addRunnerOption = useCallback(async () => {
    const name = newRunnerOptionName.trim();
    if (!name) return;
    const duplicate = runnerOptions.some(
      (opt) => opt.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      showToast(`${name} is already in the list`);
      return;
    }
    setAddingRunnerOption(true);
    try {
      const created = await createRunnerOption(name, true);
      setRunnerOptions((prev) => {
        const next = [...prev, created];
        next.sort((a, b) => a.name.localeCompare(b.name));
        return next;
      });
      setNewRunnerOptionName("");
    } catch (err) {
      console.error("[Manager] addRunnerOption failed", err);
      showToast("Could not add runner item");
    } finally {
      setAddingRunnerOption(false);
    }
  }, [newRunnerOptionName, runnerOptions]);

  const removeRunnerOption = useCallback(
    (id: string, name: string) => {
      Alert.alert(
        "Remove runner item",
        `Remove "${name}" from the runner options list?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              const snapshot = runnerOptions;
              // Optimistic removal so the row disappears immediately.
              setRunnerOptions((prev) => prev.filter((opt) => opt.id !== id));
              try {
                await deleteRunnerOption(id);
              } catch (err) {
                console.error("[Manager] removeRunnerOption failed", err);
                setRunnerOptions(snapshot);
                showToast("Could not remove runner item");
              }
            },
          },
        ]
      );
    },
    [runnerOptions]
  );

  const toggleRunnerOption = useCallback(
    async (id: string, currentStatus: boolean) => {
      const newStatus = !currentStatus;
      // Optimistic update so the switch feels instant; reconciled with the
      // server's authoritative value (or rolled back) once the request resolves.
      setRunnerOptions((prev) =>
        prev.map((opt) =>
          opt.id === id ? { ...opt, is_available: newStatus } : opt
        )
      );
      try {
        const result = await updateRunnerOptionAvailability(id, newStatus);
        setRunnerOptions((prev) =>
          prev.map((opt) =>
            opt.id === result.id
              ? { ...opt, is_available: result.is_available }
              : opt
          )
        );
      } catch (err) {
        console.error("[Manager] toggleRunnerOption failed", err);
        setRunnerOptions((prev) =>
          prev.map((opt) =>
            opt.id === id ? { ...opt, is_available: currentStatus } : opt
          )
        );
        showToast("Could not update runner item");
      }
    },
    []
  );

  // Group menu items into collapsible category sections. Priority order
  // mirrors the guest menu (Food → Desserts → Drinks → everything else
  // alphabetically) so the manager sees the same layout guests do. Rows are
  // flattened into a mixed header/item array so the existing FlatList can
  // keep windowed rendering for large menus.
  type MenuRow =
    | {
        kind: "header";
        key: string;
        categoryKey: string;
        categoryLabel: string;
        itemCount: number;
        availableCount: number;
        expanded: boolean;
      }
    | { kind: "item"; key: string; item: MenuItemRow; categoryKey: string };

  const menuRows = useMemo<MenuRow[]>(() => {
    const CATEGORY_RANK: Record<string, number> = {
      food: 0,
      desserts: 1,
      drinks: 2,
    };
    const titleCase = (s: string) =>
      s
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");

    const groups = new Map<
      string,
      { label: string; items: MenuItemRow[] }
    >();
    for (const it of menuItems) {
      const raw = (it.category ?? "").trim();
      const key = raw.toLowerCase() || "uncategorized";
      const label = raw ? titleCase(raw) : "Uncategorized";
      const g = groups.get(key);
      if (g) {
        g.items.push(it);
      } else {
        groups.set(key, { label, items: [it] });
      }
    }

    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ra = CATEGORY_RANK[a] ?? 99;
      const rb = CATEGORY_RANK[b] ?? 99;
      if (ra !== rb) return ra - rb;
      return (groups.get(a)!.label ?? "").localeCompare(
        groups.get(b)!.label ?? ""
      );
    });

    const rows: MenuRow[] = [];
    for (const key of sortedKeys) {
      const grp = groups.get(key)!;
      const expanded = expandedCategories[key] === true;
      const availableCount = grp.items.reduce(
        (n, it) => n + (it.is_available ? 1 : 0),
        0
      );
      rows.push({
        kind: "header",
        key: `header-${key}`,
        categoryKey: key,
        categoryLabel: grp.label,
        itemCount: grp.items.length,
        availableCount,
        expanded,
      });
      if (expanded) {
        for (const it of grp.items) {
          rows.push({
            kind: "item",
            key: `item-${it.id}`,
            item: it,
            categoryKey: key,
          });
        }
      }
    }
    return rows;
  }, [menuItems, expandedCategories]);

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
      <View style={styles.subheadRow}>
        <Text style={styles.subhead}>
          Toggle availability — updates save to the server when the request
          succeeds.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open analytics dashboard"
          onPress={() => navigation.navigate("ManagerAnalytics")}
          style={({ pressed }) => [
            styles.analyticsBtn,
            pressed && styles.analyticsBtnPressed,
          ]}
        >
          <Text style={styles.analyticsBtnLabel}>View Analytics</Text>
        </Pressable>
      </View>

      {/* Manager alerts — rendered OUTSIDE the menu FlatList so state updates
          always repaint. Own FlatList with scrollEnabled=false so it doesn't
          conflict with the menu list below and expands to its content. */}
      <View style={styles.alertsSection}>
        <Text style={styles.sectionTitle}>
          Manager alerts{" "}
          {managerAlerts.length > 0 ? `(${managerAlerts.length})` : ""}
        </Text>
        {managerAlerts.length === 0 ? (
          <Text style={styles.alertsEmpty}>No active alerts.</Text>
        ) : (
          <FlatList
            data={managerAlerts}
            keyExtractor={(a) => a.id}
            extraData={managerAlerts}
            scrollEnabled={false}
            contentContainerStyle={styles.alertsListContent}
            renderItem={({ item: a }) => {
              return (
                <View style={styles.alertCard}>
                  <View style={styles.alertMain}>
                    <Text style={styles.alertTable}>Table {a.table}</Text>
                    <Text style={styles.alertTime}>
                      {formatAlertTime(a.time)}
                    </Text>
                    <Text style={styles.alertReason}>
                      {a.reason || "(no reason provided)"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Block table ${a.table}`}
                    onPress={() => onBlockTable(a.table)}
                    style={({ pressed }) => [
                      styles.blockBtn,
                      pressed && styles.blockBtnPressed,
                    ]}
                  >
                    <Text style={styles.blockBtnLabel}>Block Table</Text>
                  </Pressable>
                </View>
              );
            }}
          />
        )}
      </View>

      {/* Blocked tables — small list with per-row Unblock button. Kept separate
          from the alerts section so state changes don't interfere with either. */}
      {blockedTables.length > 0 ? (
        <View style={styles.blockedSection}>
          <Text style={styles.sectionTitle}>
            Blocked tables ({blockedTables.length})
          </Text>
          <View style={styles.blockedList}>
            {blockedTables.map((t) => (
              <View key={t} style={styles.blockedChip}>
                <Text style={styles.blockedChipLabel}>Table {t}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Unblock table ${t}`}
                  onPress={() => onUnblockTable(t)}
                  style={({ pressed }) => [
                    styles.unblockBtn,
                    pressed && styles.unblockBtnPressed,
                  ]}
                >
                  <Text style={styles.unblockBtnLabel}>Unblock</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <FlatList
        style={styles.menuList}
        data={menuRows}
        keyExtractor={(row) => row.key}
        extraData={menuRows}
        contentContainerStyle={styles.listContent}
        renderItem={({ item: row }) => {
          if (row.kind === "header") {
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${
                  row.expanded ? "Collapse" : "Expand"
                } ${row.categoryLabel} section`}
                onPress={() => toggleCategoryExpanded(row.categoryKey)}
                style={({ pressed }) => [
                  styles.categoryHeader,
                  row.expanded && styles.categoryHeaderExpanded,
                  pressed && styles.categoryHeaderPressed,
                ]}
              >
                <View style={styles.categoryHeaderMain}>
                  <Text style={styles.categoryHeaderTitle}>
                    {row.categoryLabel}
                  </Text>
                  <Text style={styles.categoryHeaderMeta}>
                    {row.availableCount}/{row.itemCount} available
                  </Text>
                </View>
                <Text style={styles.categoryHeaderCaret}>
                  {row.expanded ? "▾" : "▸"}
                </Text>
              </Pressable>
            );
          }

          const item = row.item;
          return (
            <View style={styles.dishCardNested}>
              <View style={styles.dishCardTop}>
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
                  thumbColor={
                    item.is_available ? premium.manager : premium.mutedLight
                  }
                  ios_backgroundColor={premium.border}
                />
              </View>
              <View style={styles.dishActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${item.name}`}
                  onPress={() => openEditDishModal(item)}
                  style={({ pressed }) => [
                    styles.editBtn,
                    pressed && styles.editBtnPressed,
                  ]}
                  hitSlop={6}
                >
                  <Text style={styles.editBtnLabel}>Edit</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.name}`}
                  onPress={() => deleteDish(item.id, item.name)}
                  style={({ pressed }) => [
                    styles.deleteBtn,
                    pressed && styles.deleteBtnPressed,
                  ]}
                  hitSlop={6}
                >
                  <Text style={styles.deleteBtnLabel}>Delete</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
        ListHeaderComponent={
          <View style={styles.menuHeader}>
            <Text style={styles.sectionTitle}>Manage Menu Items</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add new dish"
              onPress={openAddDishModal}
              style={({ pressed }) => [
                styles.addDishBtn,
                pressed && styles.addDishBtnPressed,
              ]}
            >
              <Text style={styles.addDishBtnLabel}>+ Add New Dish</Text>
            </Pressable>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No menu items returned.</Text>
        }
        ListFooterComponent={
          <View style={styles.runnerSection}>
            <Text style={styles.sectionTitle}>Manage Runner Items</Text>
            <Text style={styles.runnerSubhead}>
              Toggle which non-menu items (napkins, ketchup, etc.) the AI may
              offer guests. Add new ones below.
            </Text>

            <View style={styles.runnerAddRow}>
              <TextInput
                value={newRunnerOptionName}
                onChangeText={setNewRunnerOptionName}
                placeholder="e.g. Ketchup"
                placeholderTextColor={premium.mutedLight}
                style={styles.runnerAddInput}
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={addRunnerOption}
                editable={!addingRunnerOption}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add runner item"
                onPress={addRunnerOption}
                disabled={
                  addingRunnerOption || newRunnerOptionName.trim().length === 0
                }
                style={({ pressed }) => [
                  styles.runnerAddBtn,
                  (addingRunnerOption ||
                    newRunnerOptionName.trim().length === 0) &&
                    styles.runnerAddBtnDisabled,
                  pressed && styles.runnerAddBtnPressed,
                ]}
              >
                <Text style={styles.runnerAddBtnLabel}>
                  {addingRunnerOption ? "Adding…" : "Add"}
                </Text>
              </Pressable>
            </View>

            {runnerOptions.length === 0 ? (
              <Text style={styles.empty}>
                No runner items yet. Add one above to start offering it to
                guests.
              </Text>
            ) : (
              runnerOptions.map((opt) => (
                <View key={opt.id} style={styles.row}>
                  <View style={styles.rowMain}>
                    <Text style={styles.name}>{opt.name}</Text>
                    <Text style={styles.meta}>
                      {opt.is_available ? "Available" : "Unavailable"}
                    </Text>
                  </View>
                  <Switch
                    value={opt.is_available}
                    onValueChange={() =>
                      toggleRunnerOption(opt.id, opt.is_available)
                    }
                    trackColor={{
                      false: premium.border,
                      true: "rgba(99, 102, 241, 0.35)",
                    }}
                    thumbColor={
                      opt.is_available ? premium.manager : premium.mutedLight
                    }
                    ios_backgroundColor={premium.border}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${opt.name}`}
                    onPress={() => removeRunnerOption(opt.id, opt.name)}
                    style={({ pressed }) => [
                      styles.runnerDeleteBtn,
                      pressed && styles.runnerDeleteBtnPressed,
                    ]}
                    hitSlop={8}
                  >
                    <Text style={styles.runnerDeleteBtnLabel}>Remove</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>
        }
      />

      <Modal
        visible={isDishModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeDishModal}
        statusBarTranslucent
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <Pressable
            style={styles.modalBackdropPress}
            onPress={closeDishModal}
            accessibilityLabel="Dismiss add-dish modal"
          />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {editingDishId ? "Edit Dish" : "Add Dish"}
            </Text>
            <Text style={styles.modalSubtitle}>
              {editingDishId
                ? "Update the details below. Changes apply immediately for everyone."
                : "Fill in the details below. The dish is available to guests by default."}
            </Text>

            <ScrollView
              style={styles.modalScroll}
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                value={newDishName}
                onChangeText={setNewDishName}
                placeholder="e.g. Classic Burger"
                placeholderTextColor={premium.mutedLight}
                style={styles.fieldInput}
                autoCapitalize="words"
                editable={!savingDish}
              />

              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput
                value={newDishDescription}
                onChangeText={setNewDishDescription}
                placeholder="Short description shown to guests"
                placeholderTextColor={premium.mutedLight}
                style={[styles.fieldInput, styles.fieldInputMultiline]}
                multiline
                numberOfLines={3}
                editable={!savingDish}
              />

              <View style={styles.fieldRow}>
                <View style={styles.fieldRowItem}>
                  <Text style={styles.fieldLabel}>Price</Text>
                  <TextInput
                    value={newDishPrice}
                    onChangeText={setNewDishPrice}
                    placeholder="e.g. 14.99"
                    placeholderTextColor={premium.mutedLight}
                    style={styles.fieldInput}
                    keyboardType="decimal-pad"
                    editable={!savingDish}
                  />
                </View>
                <View style={styles.fieldRowItem}>
                  <Text style={styles.fieldLabel}>Category</Text>
                  <TextInput
                    value={newDishCategory}
                    onChangeText={setNewDishCategory}
                    placeholder="e.g. food"
                    placeholderTextColor={premium.mutedLight}
                    style={styles.fieldInput}
                    autoCapitalize="none"
                    editable={!savingDish}
                  />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Ingredients</Text>
              <TextInput
                value={newDishIngredients}
                onChangeText={setNewDishIngredients}
                placeholder="Comma separated (e.g. beef, cheese, lettuce)"
                placeholderTextColor={premium.mutedLight}
                style={styles.fieldInput}
                autoCapitalize="none"
                editable={!savingDish}
              />

              <Text style={styles.fieldLabel}>Allergens</Text>
              <TextInput
                value={newDishAllergens}
                onChangeText={setNewDishAllergens}
                placeholder="Comma separated (e.g. dairy, nuts)"
                placeholderTextColor={premium.mutedLight}
                style={styles.fieldInput}
                autoCapitalize="none"
                editable={!savingDish}
              />
            </ScrollView>

            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                onPress={closeDishModal}
                disabled={savingDish}
                style={({ pressed }) => [
                  styles.modalCancelBtn,
                  pressed && styles.modalBtnPressed,
                  savingDish && styles.modalBtnDisabled,
                ]}
              >
                <Text style={styles.modalCancelLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={saveNewDish}
                disabled={savingDish}
                style={({ pressed }) => [
                  styles.modalSaveBtn,
                  pressed && styles.modalBtnPressed,
                  savingDish && styles.modalBtnDisabled,
                ]}
              >
                <Text style={styles.modalSaveLabel}>
                  {savingDish
                    ? "Saving…"
                    : editingDishId
                      ? "Save Changes"
                      : "Create"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
    flex: 1,
    fontSize: 13,
    color: premium.charcoalSoft,
    lineHeight: 18,
  },
  subheadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  analyticsBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: premium.charcoal,
  },
  analyticsBtnPressed: {
    opacity: 0.85,
  },
  analyticsBtnLabel: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.3,
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
  dishCard: {
    backgroundColor: premium.ivory,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: premium.border,
  },
  categoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: premium.screen,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    marginTop: 4,
    borderWidth: 1,
    borderColor: premium.border,
  },
  categoryHeaderExpanded: {
    backgroundColor: "rgba(99, 102, 241, 0.08)",
    borderColor: "rgba(99, 102, 241, 0.35)",
    marginBottom: 8,
  },
  categoryHeaderPressed: {
    opacity: 0.85,
  },
  categoryHeaderMain: {
    flex: 1,
    minWidth: 0,
  },
  categoryHeaderTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: premium.charcoal,
    letterSpacing: 0.3,
  },
  categoryHeaderMeta: {
    fontSize: 12,
    color: premium.muted,
    marginTop: 2,
  },
  categoryHeaderCaret: {
    fontSize: 18,
    color: premium.manager,
    fontWeight: "800",
    minWidth: 18,
    textAlign: "center",
  },
  dishCardNested: {
    backgroundColor: premium.ivory,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginLeft: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: premium.border,
  },
  dishCardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  dishActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 10,
  },
  editBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: premium.border,
    backgroundColor: premium.screen,
  },
  editBtnPressed: {
    opacity: 0.8,
  },
  editBtnLabel: {
    color: premium.charcoal,
    fontSize: 13,
    fontWeight: "700",
  },
  deleteBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#FCA5A5",
    backgroundColor: "#FEF2F2",
  },
  deleteBtnPressed: {
    opacity: 0.8,
  },
  deleteBtnLabel: {
    color: "#B91C1C",
    fontSize: 13,
    fontWeight: "700",
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
  menuList: {
    flex: 1,
  },
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
  },
  addDishBtn: {
    backgroundColor: premium.manager,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 18,
  },
  addDishBtnPressed: {
    opacity: 0.85,
  },
  addDishBtnLabel: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0.2,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalBackdropPress: {
    ...StyleSheet.absoluteFillObject,
  },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "90%",
    backgroundColor: premium.ivory,
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: premium.charcoal,
  },
  modalSubtitle: {
    fontSize: 13,
    color: premium.muted,
    marginTop: 4,
    marginBottom: 14,
    lineHeight: 18,
  },
  modalScroll: {
    flexGrow: 0,
  },
  modalScrollContent: {
    paddingBottom: 4,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: premium.charcoalSoft,
    marginBottom: 6,
    marginTop: 10,
  },
  fieldInput: {
    backgroundColor: premium.screen,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: premium.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: premium.charcoal,
  },
  fieldInputMultiline: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  fieldRow: {
    flexDirection: "row",
    gap: 12,
  },
  fieldRowItem: {
    flex: 1,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 18,
  },
  modalCancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: premium.border,
    backgroundColor: premium.screen,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  modalCancelLabel: {
    color: premium.charcoalSoft,
    fontSize: 14,
    fontWeight: "700",
  },
  modalSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: premium.manager,
    minWidth: 120,
    alignItems: "center",
    justifyContent: "center",
  },
  modalSaveLabel: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  modalBtnPressed: {
    opacity: 0.85,
  },
  modalBtnDisabled: {
    opacity: 0.6,
  },
  runnerSection: {
    marginTop: 24,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: premium.border,
  },
  runnerSubhead: {
    fontSize: 13,
    color: premium.muted,
    marginBottom: 12,
    lineHeight: 18,
  },
  runnerAddRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  runnerAddInput: {
    flex: 1,
    backgroundColor: premium.ivory,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: premium.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: premium.charcoal,
  },
  runnerAddBtn: {
    backgroundColor: premium.manager,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 22,
    minWidth: 84,
    alignItems: "center",
    justifyContent: "center",
  },
  runnerAddBtnPressed: {
    opacity: 0.85,
  },
  runnerAddBtnDisabled: {
    opacity: 0.5,
  },
  runnerAddBtnLabel: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.3,
  },
  runnerDeleteBtn: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#FCA5A5",
    backgroundColor: "#FEF2F2",
  },
  runnerDeleteBtnPressed: {
    opacity: 0.8,
  },
  runnerDeleteBtnLabel: {
    color: "#B91C1C",
    fontSize: 12,
    fontWeight: "700",
  },
  alertsSection: {
    flexShrink: 0,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 8,
    maxHeight: 320,
    backgroundColor: premium.screen,
  },
  alertsListContent: {
    paddingBottom: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: premium.charcoal,
    marginBottom: 8,
  },
  alertsEmpty: {
    fontSize: 13,
    color: premium.muted,
    paddingVertical: 8,
  },
  alertCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: premium.ivory,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: premium.border,
  },
  alertMain: {
    flex: 1,
    minWidth: 0,
  },
  alertTable: {
    fontSize: 15,
    fontWeight: "700",
    color: premium.charcoal,
  },
  alertTime: {
    fontSize: 12,
    color: premium.muted,
    marginTop: 2,
  },
  alertReason: {
    fontSize: 14,
    color: premium.charcoal,
    marginTop: 6,
    lineHeight: 18,
  },
  blockBtn: {
    backgroundColor: "#DC2626",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
    minWidth: 110,
    alignItems: "center",
    justifyContent: "center",
  },
  blockBtnPressed: {
    opacity: 0.85,
  },
  blockBtnLabel: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0.3,
  },
  blockedSection: {
    flexShrink: 0,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 10,
    backgroundColor: premium.screen,
  },
  blockedList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  blockedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: premium.ivory,
    borderRadius: 999,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    borderWidth: 1,
    borderColor: premium.border,
  },
  blockedChipLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: premium.charcoal,
  },
  unblockBtn: {
    backgroundColor: "#16A34A",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  unblockBtnPressed: {
    opacity: 0.85,
  },
  unblockBtnLabel: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.3,
  },
});
