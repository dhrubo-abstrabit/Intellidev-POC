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

  describe("with a timeZone", () => {
    it("returns the exact local-midnight boundaries for UTC, with no buffer", () => {
      const window = utcWindowForDay("2026-08-01", "UTC");
      expect(window.gte).toBe("2026-08-01T00:00:00.000Z");
      expect(window.lt).toBe("2026-08-02T00:00:00.000Z");
    });

    it("returns the exact local-midnight boundaries for a positive offset (Asia/Kolkata, +05:30)", () => {
      const window = utcWindowForDay("2026-08-01", "Asia/Kolkata");
      expect(window.gte).toBe("2026-07-31T18:30:00.000Z");
      expect(window.lt).toBe("2026-08-01T18:30:00.000Z");
    });

    it("returns the exact local-midnight boundaries for a negative offset (America/Los_Angeles, PDT)", () => {
      const window = utcWindowForDay("2026-08-01", "America/Los_Angeles");
      expect(window.gte).toBe("2026-08-01T07:00:00.000Z");
      expect(window.lt).toBe("2026-08-02T07:00:00.000Z");
    });

    it("does not leave a gap: the exact lt of one day equals the exact gte of the next", () => {
      const day1 = utcWindowForDay("2026-08-01", "Asia/Kolkata");
      const day2 = utcWindowForDay("2026-08-02", "Asia/Kolkata");
      expect(day1.lt).toBe(day2.gte);
    });

    it("handles a spring-forward DST transition correctly (America/Los_Angeles, 2026-03-08)", () => {
      // Clocks skip 02:00 -> 03:00 local at 2026-03-08T10:00:00Z (still PST, UTC-8,
      // until that instant). Local midnight on 2026-03-08 is unaffected by the
      // transition (it happens later that day), so it's still a clean UTC-8 offset.
      const window = utcWindowForDay("2026-03-08", "America/Los_Angeles");
      expect(window.gte).toBe("2026-03-08T08:00:00.000Z");
    });
  });
});
