import { describe, expect, it } from "vitest";
import { isoDaysAgo, projectDayKey, projectTimeLabel, projectToday, utcWindowForDay } from "./project-day";

describe("projectDayKey", () => {
  it("buckets an instant just after UTC midnight into the previous day for a negative offset (America/Los_Angeles)", () => {
    // 2026-08-02T02:00:00Z is 2026-08-01T19:00:00 in America/Los_Angeles (UTC-7 in August, DST).
    expect(projectDayKey("2026-08-02T02:00:00.000Z", "America/Los_Angeles")).toBe("2026-08-01");
  });

  it("buckets an instant just before UTC midnight into the next day for a positive offset (Asia/Kolkata, +05:30)", () => {
    // 2026-08-01T19:00:00Z is 2026-08-02T00:30:00 in Asia/Kolkata (UTC+5:30) —
    // the half-hour offset catches naive integer-hour math.
    expect(projectDayKey("2026-08-01T19:00:00.000Z", "Asia/Kolkata")).toBe("2026-08-02");
  });

  it("matches the UTC calendar day for the UTC timezone", () => {
    expect(projectDayKey("2026-08-01T23:59:00.000Z", "UTC")).toBe("2026-08-01");
    expect(projectDayKey("2026-08-02T00:00:00.000Z", "UTC")).toBe("2026-08-02");
  });
});

describe("isoDaysAgo", () => {
  it("returns an ISO instant roughly N days before now", () => {
    const now = Date.now();
    const iso = isoDaysAgo(60);
    const deltaMs = now - new Date(iso).getTime();
    const expectedMs = 60 * 24 * 60 * 60 * 1000;
    expect(Math.abs(deltaMs - expectedMs)).toBeLessThan(5000);
  });
});

describe("projectToday", () => {
  it("returns a YYYY-MM-DD key", () => {
    expect(projectToday("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("projectTimeLabel", () => {
  it("renders a 24h HH:mm label in the given timezone", () => {
    expect(projectTimeLabel("2026-08-01T10:59:00.000Z", "UTC")).toBe("10:59");
  });

  it("shifts correctly for a positive offset", () => {
    expect(projectTimeLabel("2026-08-01T19:00:00.000Z", "Asia/Kolkata")).toBe("00:30");
  });
});

describe("utcWindowForDay", () => {
  it("brackets the whole local day for a negative offset (America/Los_Angeles)", () => {
    const window = utcWindowForDay("2026-08-01");
    // Local midnight and local 23:59 on 2026-08-01 in America/Los_Angeles,
    // expressed as UTC instants, must both fall inside [gte, lt).
    const localMidnightUtc = new Date("2026-08-01T07:00:00.000Z"); // PDT, UTC-7
    const localEndOfDayUtc = new Date("2026-08-02T06:59:00.000Z");
    expect(localMidnightUtc.toISOString() >= window.gte).toBe(true);
    expect(localMidnightUtc.toISOString() < window.lt).toBe(true);
    expect(localEndOfDayUtc.toISOString() >= window.gte).toBe(true);
    expect(localEndOfDayUtc.toISOString() < window.lt).toBe(true);
  });

  it("brackets the whole local day for a positive offset (Asia/Kolkata)", () => {
    const window = utcWindowForDay("2026-08-01");
    const localMidnightUtc = new Date("2026-07-31T18:30:00.000Z"); // IST, UTC+5:30
    const localEndOfDayUtc = new Date("2026-08-01T18:29:00.000Z");
    expect(localMidnightUtc.toISOString() >= window.gte).toBe(true);
    expect(localMidnightUtc.toISOString() < window.lt).toBe(true);
    expect(localEndOfDayUtc.toISOString() >= window.gte).toBe(true);
    expect(localEndOfDayUtc.toISOString() < window.lt).toBe(true);
  });

  it("brackets the day for UTC itself", () => {
    const window = utcWindowForDay("2026-08-01");
    expect(new Date("2026-08-01T00:00:00.000Z").toISOString() >= window.gte).toBe(true);
    expect(new Date("2026-08-01T23:59:00.000Z").toISOString() < window.lt).toBe(true);
  });

  it("returns a half-open range whose bounds are ISO strings", () => {
    const window = utcWindowForDay("2026-08-01");
    expect(window.gte).toBe(new Date(window.gte).toISOString());
    expect(window.lt).toBe(new Date(window.lt).toISOString());
    expect(window.gte < window.lt).toBe(true);
  });
});
