import { create } from "zustand";

export type StaffRole = "manager" | "kitchen" | "runner";

/**
 * PIN -> role map for the staff Auth Gate.
 * REPLACE: swap for a real auth check against the backend once staff
 * accounts exist; this is a simulator-grade stand-in.
 */
export const STAFF_PINS: Record<string, StaffRole> = {
  "1111": "manager",
  "2222": "kitchen",
  "3333": "runner",
};

interface AuthState {
  role: StaffRole | null;
  /** Looks up `pin` in STAFF_PINS and logs in on a match. Returns the role on success, null on an invalid PIN. */
  loginWithPin: (pin: string) => StaffRole | null;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  role: null,

  loginWithPin: (pin) => {
    const role = STAFF_PINS[pin.trim()] ?? null;
    if (role) set({ role });
    return role;
  },

  logout: () => set({ role: null }),
}));
