import { describe, expect, it } from "vitest";
import { parseProjectDataSearchParams, projectDataHref } from "./filters";

describe("parseProjectDataSearchParams", () => {
  it("defaults to no date filter and all connectors with no params", () => {
    expect(parseProjectDataSearchParams({})).toEqual({ date: null, connector: "all", service: "all" });
  });

  it("accepts a well-formed date key", () => {
    expect(parseProjectDataSearchParams({ date: "2026-08-01" }).date).toBe("2026-08-01");
  });

  it("falls back to null for a malformed date instead of erroring", () => {
    expect(parseProjectDataSearchParams({ date: "notadate" }).date).toBeNull();
    expect(parseProjectDataSearchParams({ date: "2026-8-1" }).date).toBeNull();
    expect(parseProjectDataSearchParams({ date: "" }).date).toBeNull();
  });

  it("accepts a known connector", () => {
    expect(parseProjectDataSearchParams({ connector: "slack" }).connector).toBe("slack");
    expect(parseProjectDataSearchParams({ connector: "google" }).connector).toBe("google");
    // Retired as a connector, but still a valid provider on historical rows.
    expect(parseProjectDataSearchParams({ connector: "google_chat" }).connector).toBe("google_chat");
  });

  it("falls back to 'all' for an unknown connector instead of erroring", () => {
    expect(parseProjectDataSearchParams({ connector: "bogus" }).connector).toBe("all");
  });

  it("accepts a known google sub-service, and falls back to 'all' otherwise", () => {
    expect(parseProjectDataSearchParams({ connector: "google", service: "drive" }).service).toBe("drive");
    expect(parseProjectDataSearchParams({ connector: "google", service: "bogus" }).service).toBe("all");
    expect(parseProjectDataSearchParams({ connector: "google" }).service).toBe("all");
  });

  it("takes the first value when a param is repeated", () => {
    expect(parseProjectDataSearchParams({ date: ["2026-08-01", "2026-08-02"] }).date).toBe("2026-08-01");
    expect(parseProjectDataSearchParams({ connector: ["slack", "mock"] }).connector).toBe("slack");
  });
});

describe("projectDataHref", () => {
  it("sets only the date param for connector 'all'", () => {
    expect(projectDataHref({ date: "2026-08-01", connector: "all", service: "all" })).toBe("?date=2026-08-01");
  });

  it("includes the connector param when set", () => {
    expect(projectDataHref({ date: "2026-08-01", connector: "slack", service: "all" })).toBe(
      "?date=2026-08-01&connector=slack",
    );
  });

  it("omits the date param when null", () => {
    expect(projectDataHref({ date: null, connector: "slack", service: "all" })).toBe("?connector=slack");
  });

  it("includes the service param only alongside the google connector", () => {
    expect(projectDataHref({ date: null, connector: "google", service: "chat" })).toBe("?connector=google&service=chat");
    // A service filter with no google connector selected can't be applied by
    // the page, so it's never written into the URL.
    expect(projectDataHref({ date: null, connector: "slack", service: "chat" })).toBe("?connector=slack");
    expect(projectDataHref({ date: null, connector: "all", service: "chat" })).toBe("?");
  });
});
