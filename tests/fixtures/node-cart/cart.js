export const subtotal = (items) => items.reduce((s, i) => s + i.price * i.qty, 0);
export const tax = (n) => Math.round(n * 0.21);
export const discount = (n, p) => n - Math.round(n * p / 10); // bug: /10
export const total = (items, p = 0) => { const d = discount(subtotal(items), p); return d + tax(d); };
export const first = (items) => items[0].name;
