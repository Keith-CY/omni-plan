import { describe, expect, it } from "vitest";

import {
  SOURCE_DEFAULT_APP_GENERATION,
  resolveAppGeneration,
} from "./appEntry";

describe("application generation resolution", () => {
  it.each([
    ["v1", "v1"],
    ["v2", "v2"],
  ] as const)("selects explicit %s", (value, expected) => {
    expect(resolveAppGeneration(value, "v1")).toBe(expected);
  });

  it.each([undefined, ""])(
    "uses the source default when the build value is %s",
    (value) => {
      expect(resolveAppGeneration(value, "v1")).toBe("v1");
      expect(resolveAppGeneration(value, "v2")).toBe("v2");
    },
  );

  it("keeps the ordinary source default on V1 until the production cutover", () => {
    expect(SOURCE_DEFAULT_APP_GENERATION).toBe("v1");
    expect(resolveAppGeneration(undefined, SOURCE_DEFAULT_APP_GENERATION)).toBe(
      "v1",
    );
  });

  it.each(["V2", "beta", " v2 ", "0"])(
    "rejects unsupported build generation %s",
    (value) => {
      expect(() => resolveAppGeneration(value, "v1")).toThrow(
        `Unsupported OmniPlan generation: ${value}`,
      );
    },
  );

  it("depends only on the build value and explicit source default", () => {
    expect(resolveAppGeneration).toHaveLength(2);
    expect(resolveAppGeneration(undefined, "v1")).toBe("v1");
    expect(resolveAppGeneration(undefined, "v2")).toBe("v2");
  });
});
