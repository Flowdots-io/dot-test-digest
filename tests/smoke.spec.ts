import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("toolchain", () => {
  it("exposes the package version", () => {
    expect(VERSION).toBe("0.2.0");
  });
});
