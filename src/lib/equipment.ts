import { all, get, run, tx } from "./db.ts";
import type { Item } from "./types.ts";

// What a vendor owns ("Print booth × 6", "360 booth × 2"). A package (or an
// add-on) can use one piece of equipment; a date is free for it while that
// equipment has a unit left. Vendors with no equipment keep the plain
// "jobs per day" counter.

export interface Equipment {
  id: number;
  vendor_id: number;
  name: string;
  quantity: number;
  sort: number;
}

export const listEquipment = (vendorId: number) =>
  all<Equipment>("SELECT * FROM equipment WHERE vendor_id = ? ORDER BY sort, id", vendorId);

export const hasEquipment = (vendorId: number) => !!get("SELECT 1 FROM equipment WHERE vendor_id = ? LIMIT 1", vendorId);

function clean(name: string, quantity: number) {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!n) throw new Error("Give the equipment a name, e.g. \"360 booth\".");
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("How many you own must be a whole number, at least 1.");
  if (quantity > 999) throw new Error("That's a lot of equipment: enter 999 or fewer.");
  return n;
}

export function addEquipment(vendorId: number, name: string, quantity: number): number {
  const n = clean(name, quantity);
  if (get("SELECT 1 FROM equipment WHERE vendor_id = ? AND name = ? COLLATE NOCASE", vendorId, n)) throw new Error(`You already have "${n}".`);
  const sort = get<{ n: number }>("SELECT COALESCE(MAX(sort), 0) + 1 n FROM equipment WHERE vendor_id = ?", vendorId)!.n;
  return run("INSERT INTO equipment (vendor_id, name, quantity, sort) VALUES (?, ?, ?, ?)", vendorId, n, quantity, sort);
}

export function updateEquipment(vendorId: number, id: number, name: string, quantity: number) {
  const n = clean(name, quantity);
  if (!get("SELECT 1 FROM equipment WHERE id = ? AND vendor_id = ?", id, vendorId)) throw new Error("Equipment not found");
  run("UPDATE equipment SET name = ?, quantity = ? WHERE id = ? AND vendor_id = ?", n, quantity, id, vendorId);
}

/** Items that use this equipment (to warn before deleting it). */
export const itemsUsing = (vendorId: number, equipmentId: number) =>
  all<{ id: number; name: string }>("SELECT id, name FROM items WHERE vendor_id = ? AND equipment_id = ? ORDER BY sort, id", vendorId, equipmentId);

/** Deletes equipment; the items that used it stop being limited by it. Returns how many items were unlinked. */
export function deleteEquipment(vendorId: number, id: number): number {
  return tx(() => {
    const n = itemsUsing(vendorId, id).length;
    run("UPDATE items SET equipment_id = NULL WHERE vendor_id = ? AND equipment_id = ?", vendorId, id);
    run("DELETE FROM equipment WHERE id = ? AND vendor_id = ?", id, vendorId);
    return n;
  });
}

/** The equipment id from a form, only if it belongs to this vendor (anything else means "none"). */
export function ownEquipmentId(vendorId: number, raw: unknown): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return get("SELECT 1 FROM equipment WHERE id = ? AND vendor_id = ?", id, vendorId) ? id : null;
}

/** "Classic Booth 3h" → "classic booth": packages in the same family share equipment. */
export const family = (name: string) => name.toLowerCase().replace(/\s*[\d.]+\s*(h|hr|hrs|hours?)\b.*$/, "").trim();

/**
 * For a vendor with packages but no equipment yet: one suggestion per package
 * family ("Classic Booth" for Classic Booth 2h/3h/4h), quantity 1, for the
 * vendor to confirm. Nothing is created or linked until they save.
 */
export function suggestEquipment(items: Pick<Item, "id" | "kind" | "name" | "equipment_id">[]): { name: string; itemIds: number[]; itemNames: string[] }[] {
  const groups = new Map<string, { name: string; itemIds: number[]; itemNames: string[] }>();
  for (const i of items) {
    if (i.kind !== "package" || i.equipment_id) continue;
    const f = family(i.name);
    if (!f) continue;
    const name = i.name.replace(/\s*[\d.]+\s*(h|hr|hrs|hours?)\b.*$/i, "").trim() || i.name;
    const g = groups.get(f) ?? { name, itemIds: [], itemNames: [] };
    g.itemIds.push(i.id);
    g.itemNames.push(i.name);
    groups.set(f, g);
  }
  return [...groups.values()];
}

/** Create the suggested equipment the vendor ticked and link each family's packages to it. */
export function addSuggestedEquipment(vendorId: number, picks: { name: string; quantity: number; itemIds: number[] }[]): number {
  return tx(() => {
    let added = 0;
    for (const p of picks) {
      const id = addEquipment(vendorId, p.name, p.quantity);
      for (const itemId of p.itemIds) run("UPDATE items SET equipment_id = ? WHERE id = ? AND vendor_id = ?", id, itemId, vendorId);
      added++;
    }
    return added;
  });
}
