export type Item = { name: string; cents: number; qty: number };
export const subtotal = (items: Item[]) => items.reduce((s, i) => s + i.cents * i.qty, 0);
export const discount = (cents: number, pct: number) => Math.floor(cents * (pct / 100)); // bug: returns the discount, not the amount left
export const tax = (cents: number) => Math.round(cents * 0.21);
export const total = (items: Item[], pct = 0) => {
  const base = subtotal(items);
  const d = discount(base, pct);
  return d + tax(d); // bug propagates here
};
export const first = (items: Item[]) => items[0].name; // crashes on an empty cart
