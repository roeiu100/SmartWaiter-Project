import type { MenuItemRow } from "../types/database";

/** Static demo menu; replace with GET /menu from your Node API. */
export const MOCK_MENU_ITEMS: MenuItemRow[] = [
  {
    id: "m1",
    name: "House Salad",
    price: 9.5,
    category: "Starters",
    is_available: true,
  },
  {
    id: "m2",
    name: "Margherita Pizza",
    price: 14.0,
    category: "Mains",
    is_available: true,
  },
  {
    id: "m3",
    name: "Grilled Salmon",
    price: 22.5,
    category: "Mains",
    is_available: true,
  },
  {
    id: "m4",
    name: "Chocolate Cake",
    price: 7.0,
    category: "Desserts",
    is_available: true,
  },
];
