import { describe, expect, it } from "vitest";
import { parseTaskManagementSearchParams } from "./filters";

describe("parseTaskManagementSearchParams", () => {
  it("defaults to board (kanban) view with no filters", () => {
    expect(parseTaskManagementSearchParams({})).toEqual({
      view: "kanban",
      q: "",
      priority: [],
      assignee: null,
      kind: [],
      sort: "for_date",
      status: [],
    });
  });

  it("falls back to board view for anything other than an explicit view=list", () => {
    expect(parseTaskManagementSearchParams({ view: "bogus" }).view).toBe("kanban");
    expect(parseTaskManagementSearchParams({ view: "list" }).view).toBe("list");
  });

  it("defaults list view to the pending/in_progress status set", () => {
    expect(parseTaskManagementSearchParams({ view: "list" }).status).toEqual(["pending", "in_progress"]);
  });

  it("trims search text", () => {
    expect(parseTaskManagementSearchParams({ q: "  fix the build  " }).q).toBe("fix the build");
  });

  it("drops unknown enum values instead of passing them through", () => {
    const filters = parseTaskManagementSearchParams({ priority: "high,not-a-priority", kind: "action,bogus" });
    expect(filters.priority).toEqual(["high"]);
    expect(filters.kind).toEqual(["action"]);
  });

  it("respects an explicit status filter in list view", () => {
    expect(parseTaskManagementSearchParams({ view: "list", status: "snoozed" }).status).toEqual(["snoozed"]);
  });

  it("ignores a status param when view=kanban rather than erroring", () => {
    const filters = parseTaskManagementSearchParams({ view: "kanban", status: "snoozed" });
    expect(filters.view).toBe("kanban");
    expect(filters.status).toEqual([]);
  });

  it("takes the first value when a param is repeated", () => {
    expect(parseTaskManagementSearchParams({ assignee: ["user-1", "user-2"] }).assignee).toBe("user-1");
  });

  it("treats an empty assignee param as no filter, and 'unassigned' as a real value", () => {
    expect(parseTaskManagementSearchParams({ assignee: "" }).assignee).toBeNull();
    expect(parseTaskManagementSearchParams({ assignee: "unassigned" }).assignee).toBe("unassigned");
  });

  it("only accepts sort=priority; anything else falls back to for_date", () => {
    expect(parseTaskManagementSearchParams({ sort: "priority" }).sort).toBe("priority");
    expect(parseTaskManagementSearchParams({ sort: "bogus" }).sort).toBe("for_date");
  });
});
