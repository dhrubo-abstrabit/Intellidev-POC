import { describe, expect, it } from "vitest";
import { UNASSIGNED_VALUE, decodeAssigneeValue, encodeAssigneeValue } from "./assignee";

describe("assignee codec", () => {
  it("round-trips a user id", () => {
    const encoded = encodeAssigneeValue("user", "11111111-1111-1111-1111-111111111111");
    expect(encoded).toBe("user:11111111-1111-1111-1111-111111111111");
    expect(decodeAssigneeValue(encoded)).toEqual({ kind: "user", id: "11111111-1111-1111-1111-111111111111" });
  });

  it("round-trips a team_member id", () => {
    const encoded = encodeAssigneeValue("team_member", "22222222-2222-2222-2222-222222222222");
    expect(encoded).toBe("team:22222222-2222-2222-2222-222222222222");
    expect(decodeAssigneeValue(encoded)).toEqual({ kind: "team_member", id: "22222222-2222-2222-2222-222222222222" });
  });

  it("decodes the unassigned sentinel as null", () => {
    expect(decodeAssigneeValue(UNASSIGNED_VALUE)).toBeNull();
  });

  it("decodes an unrecognized prefix as null", () => {
    expect(decodeAssigneeValue("bogus:11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  it("decodes a prefix with no id as null", () => {
    expect(decodeAssigneeValue("user:")).toBeNull();
  });

  it("treats a bare uuid (no colon) as a legacy user id", () => {
    expect(decodeAssigneeValue("33333333-3333-3333-3333-333333333333")).toEqual({
      kind: "user",
      id: "33333333-3333-3333-3333-333333333333",
    });
  });
});
