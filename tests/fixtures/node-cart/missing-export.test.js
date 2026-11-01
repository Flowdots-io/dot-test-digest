import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCoupon } from "./cart.js";
test("coupon", () => assert.equal(applyCoupon(100, "TEN"), 90));
