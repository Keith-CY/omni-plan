import { describe, expect, it } from "vitest";
import { createEmptyWorkspace, createPersonalResource, personalResourceId } from "./workspace";

describe("personal workspace defaults", () => {
  it("starts with one unobtrusive personal planning resource", () => {
    const workspace = createEmptyWorkspace();

    expect(workspace.resources).toEqual([createPersonalResource()]);
    expect(workspace.resources[0]).toMatchObject({ id: personalResourceId, name: "我", role: "Owner" });
    expect(workspace.resources[0].capacityByAttention).toEqual({
      deep: 4 * 60 * 60,
      medium: 3 * 60 * 60,
      shallow: 2 * 60 * 60
    });
  });
});
