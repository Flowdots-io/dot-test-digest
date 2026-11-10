import test, { describe, before } from "node:test";
test("plain", () => { throw new Error("z"); });
test("empty", () => { throw new Error(""); });
test("typed", () => { throw new TypeError("t"); });
describe("suite", () => { before(() => { throw new Error("hb"); }); test("inner", () => {}); });
