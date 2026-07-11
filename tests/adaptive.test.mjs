import { describe, expect, test } from "bun:test";

import { adaptiveMinChars } from "../src/index.ts";

describe("adaptiveMinChars", () => {
  // Defaults: start 0.5, full 0.9, floor 0.25.
  test("keeps the base threshold while the context is comfortable", () => {
    expect(adaptiveMinChars(12000, 0)).toBe(12000);
    expect(adaptiveMinChars(12000, 0.5)).toBe(12000);
  });

  test("shrinks linearly between start and full", () => {
    expect(adaptiveMinChars(12000, 0.7)).toBe(7500);
  });

  test("clamps at the floor when the context is full", () => {
    expect(adaptiveMinChars(12000, 0.9)).toBe(3000);
    expect(adaptiveMinChars(12000, 1)).toBe(3000);
  });

  test("disabled mode is a passthrough", () => {
    expect(adaptiveMinChars(12000, 0.99, { enabled: false })).toBe(12000);
  });

  test("invalid inputs stay safe", () => {
    expect(adaptiveMinChars(12000, NaN)).toBe(12000);
    expect(adaptiveMinChars(NaN, 0.9)).toBe(0);
  });

  test("is monotonically non-increasing over usage", () => {
    let prev = Infinity;
    for (let ratio = 0; ratio <= 1.001; ratio += 0.05) {
      const value = adaptiveMinChars(8000, ratio);
      expect(value).toBeLessThanOrEqual(prev);
      prev = value;
    }
  });
});
