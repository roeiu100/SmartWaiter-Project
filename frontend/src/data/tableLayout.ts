/**
 * Table Map floor-plan positions. There is no `tables` table in Supabase —
 * this is a hardcoded frontend layout (same "fixed demo table set" spirit
 * as the old `TABLE_IDS` array it replaces). Rearranging the floor plan
 * means editing the entries below; there's no live drag-and-drop editor
 * (yet) since nothing currently persists layout changes anywhere.
 */

export type TableShape = "rect" | "round";

export interface TableLayoutEntry {
  id: string;
  /** Normalized 0–1 position of the table's CENTER within the floor-plan canvas. */
  x: number;
  y: number;
  /** Degrees, clockwise. Default 0. */
  rotation?: number;
  /** Seat count — drives how many chair marks render around the table. Default 4. */
  seats?: number;
  /** Default "rect". */
  shape?: TableShape;
}

/** Placeholder arrangement — tune freely to match your actual floor plan. */
export const TABLE_LAYOUT: TableLayoutEntry[] = [
  { id: "1", x: 0.18, y: 0.22, seats: 4, shape: "rect" },
  { id: "2", x: 0.58, y: 0.18, seats: 2, shape: "round" },
  { id: "3", x: 0.84, y: 0.4, seats: 4, shape: "rect", rotation: 90 },
  { id: "4", x: 0.28, y: 0.72, seats: 6, shape: "rect" },
  { id: "5", x: 0.74, y: 0.78, seats: 2, shape: "round" },
];
