import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal } from "./missing.js";
test("subtotal", () => assert.equal(subtotal([]), 0));
