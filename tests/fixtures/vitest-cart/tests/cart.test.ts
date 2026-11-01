import { describe, expect, it } from "vitest";
import { discount, first, subtotal, tax, total } from "../src/cart";
const items = [{ name: "pen", cents: 150, qty: 2 }, { name: "book", cents: 1200, qty: 1 }];
describe("cart", () => {
  it("subtotal adds up", () => expect(subtotal(items)).toBe(1500));
  it("tax is 21%", () => expect(tax(1000)).toBe(210));
  it("discount 10% leaves 90%", () => expect(discount(1000, 10)).toBe(900));
  it("discount 50% leaves half", () => expect(discount(2000, 50)).toBe(1000));
  it("total without discount", () => expect(total(items)).toBe(1815));
  it("total with 10% off", () => expect(total(items, 10)).toBe(1634));
  it("total with 100% off is free", () => expect(total(items, 100)).toBe(0));
  it("first item name", () => expect(first(items)).toBe("pen"));
  it("first of an empty cart is undefined", () => expect(first([])).toBeUndefined());
  for (let n = 1; n <= 20; n++) it(`subtotal of ${n} pens`, () => expect(subtotal([{ name: "pen", cents: 100, qty: n }])).toBe(100 * n));
});
