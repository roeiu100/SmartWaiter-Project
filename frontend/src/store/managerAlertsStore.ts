import { create } from "zustand";

export interface ManagerAlert {
  id: string;
  table: string;
  reason: string;
  time: string;
}

interface ManagerAlertsState {
  alerts: ManagerAlert[];
  blockedTables: string[];
  addAlert: (alert: ManagerAlert) => void;
  removeByTable: (table: string) => void;
  clearAll: () => void;
  setBlockedTables: (tables: string[]) => void;
}

export const useManagerAlertsStore = create<ManagerAlertsState>((set) => ({
  alerts: [],
  blockedTables: [],

  addAlert: (alert) =>
    set((s) => ({ alerts: [alert, ...s.alerts] })),

  removeByTable: (table) =>
    set((s) => ({ alerts: s.alerts.filter((a) => a.table !== table) })),

  clearAll: () => set({ alerts: [] }),

  setBlockedTables: (tables) =>
    set(() => ({
      blockedTables: Array.isArray(tables)
        ? tables.map(String).filter((t) => t.length > 0)
        : [],
    })),
}));
