import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discount, first } from "./cart.js";
describe("cart", () => {
  it("discount 10% leaves 90%", () => assert.equal(discount(1000, 10), 900));
  it("first item name", () => assert.equal(first([{ name: "pen" }]), "pen"));
  it("names match", () => assert.deepEqual({ a: 1 }, { a: 2 }));
  it("slow", { timeout: 20 }, async () => { await new Promise((r) => setTimeout(r, 200)); });
});
