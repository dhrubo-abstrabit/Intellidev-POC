import { describe, expect, it } from "vitest";
import {
  CUSTOM_PRESET_VALUE,
  MAX_SYNC_INTERVAL_SECONDS,
  MIN_SYNC_INTERVAL_SECONDS,
  SYNC_INTERVAL_PRESETS,
  describeSchedule,
  parseScheduleFormData,
  parseScheduleParts,
  scheduleBadgeLabel,
  secondsToCustomParts,
  secondsToLabel,
  secondsToPresetValue,
} from "@/lib/sync/schedule";

describe("secondsToPresetValue", () => {
  it("matches every declared preset exactly", () => {
    for (const preset of SYNC_INTERVAL_PRESETS) {
      expect(secondsToPresetValue(preset.seconds)).toBe(preset.value);
    }
  });

  it("falls back to custom for a non-preset value", () => {
    expect(secondsToPresetValue(2700)).toBe(CUSTOM_PRESET_VALUE);
  });
});

describe("secondsToCustomParts", () => {
  it("prefers whole hours when evenly divisible", () => {
    expect(secondsToCustomParts(21600)).toEqual({ amount: 6, unit: "hours" });
    expect(secondsToCustomParts(3600)).toEqual({ amount: 1, unit: "hours" });
  });

  it("falls back to minutes otherwise", () => {
    expect(secondsToCustomParts(2700)).toEqual({ amount: 45, unit: "minutes" });
    expect(secondsToCustomParts(900)).toEqual({ amount: 15, unit: "minutes" });
  });

  it("floors at 1 minute", () => {
    expect(secondsToCustomParts(60)).toEqual({ amount: 1, unit: "minutes" });
  });
});

describe("secondsToLabel", () => {
  it("prefers a preset's own phrasing on an exact match", () => {
    expect(secondsToLabel(3600)).toBe("every hour");
    expect(secondsToLabel(86400)).toBe("once a day");
    expect(secondsToLabel(900)).toBe("every 15 minutes");
  });

  it("derives hours for a non-preset multiple of an hour, with correct plural", () => {
    expect(secondsToLabel(7200)).toBe("every 2 hours");
  });

  it("derives minutes for anything else, with correct singular/plural", () => {
    expect(secondsToLabel(2700)).toBe("every 45 minutes");
    expect(secondsToLabel(60)).toBe("every 1 minute");
  });
});

describe("describeSchedule", () => {
  it("describes an active schedule", () => {
    expect(describeSchedule(900, true)).toBe("Syncs every 15 minutes.");
  });

  it("describes a paused connector regardless of interval", () => {
    expect(describeSchedule(900, false)).toBe("Automatic syncing is paused.");
  });
});

describe("scheduleBadgeLabel", () => {
  it("uses the preset label when active", () => {
    expect(scheduleBadgeLabel(3600, true)).toBe("Every hour");
  });

  it("capitalizes a derived label when active and non-preset", () => {
    expect(scheduleBadgeLabel(2700, true)).toBe("Every 45 minutes");
  });

  it("reads Paused when inactive, regardless of interval", () => {
    expect(scheduleBadgeLabel(3600, false)).toBe("Paused");
  });
});

describe("parseScheduleParts", () => {
  it("rejects a missing preset", () => {
    expect(parseScheduleParts(null, null, null)).toEqual({ ok: false, error: "Choose how often this connector should sync." });
    expect(parseScheduleParts("", null, null)).toEqual({ ok: false, error: "Choose how often this connector should sync." });
  });

  it("rejects a preset value that was never offered", () => {
    expect(parseScheduleParts("999999", null, null)).toEqual({ ok: false, error: "That sync frequency isn't available." });
  });

  it("accepts every declared preset", () => {
    for (const preset of SYNC_INTERVAL_PRESETS) {
      expect(parseScheduleParts(preset.value, null, null)).toEqual({ ok: true, intervalSeconds: preset.seconds });
    }
  });

  it("rejects a missing or blank custom amount", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, null, "minutes")).toEqual({
      ok: false,
      error: "Enter how often this connector should sync.",
    });
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "   ", "minutes")).toEqual({
      ok: false,
      error: "Enter how often this connector should sync.",
    });
  });

  it.each(["1.5", "-5", "1e3", "abc", "Infinity", "NaN"])("rejects a malformed custom amount %s", (amount) => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, amount, "minutes")).toEqual({
      ok: false,
      error: "Sync interval must be a whole number of minutes or hours.",
    });
  });

  it("trims surrounding whitespace on an otherwise-valid amount", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, " 45 ", "minutes")).toEqual({ ok: true, intervalSeconds: 2700 });
  });

  it("rejects a missing or invalid unit", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "45", null)).toEqual({ ok: false, error: "Choose minutes or hours." });
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "45", "seconds")).toEqual({ ok: false, error: "Choose minutes or hours." });
  });

  it("rejects a custom interval under the 60-second floor", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "0", "minutes")).toEqual({
      ok: false,
      error: "Syncs can run at most once a minute — choose 1 minute or more.",
    });
  });

  it("accepts the 60-second floor exactly", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "1", "minutes")).toEqual({ ok: true, intervalSeconds: MIN_SYNC_INTERVAL_SECONDS });
  });

  it("rejects a custom interval over the 24-hour ceiling", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "25", "hours")).toEqual({
      ok: false,
      error: "Syncs must run at least once a day — choose 24 hours or less.",
    });
  });

  it("accepts the 24-hour ceiling exactly", () => {
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, "24", "hours")).toEqual({ ok: true, intervalSeconds: MAX_SYNC_INTERVAL_SECONDS });
  });

  it("stays a safe integer even for the largest representable amount", () => {
    const result = parseScheduleParts(CUSTOM_PRESET_VALUE, "9999999", "hours");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("24 hours or less");
  });

  it("round-trips secondsToCustomParts through parseScheduleParts", () => {
    const parts = secondsToCustomParts(2700);
    expect(parseScheduleParts(CUSTOM_PRESET_VALUE, String(parts.amount), parts.unit)).toEqual({ ok: true, intervalSeconds: 2700 });
  });
});

describe("parseScheduleFormData", () => {
  it("reads the preset path from FormData", () => {
    const formData = new FormData();
    formData.set("syncPreset", "3600");
    expect(parseScheduleFormData(formData)).toEqual({ ok: true, intervalSeconds: 3600 });
  });

  it("reads the custom path from FormData", () => {
    const formData = new FormData();
    formData.set("syncPreset", CUSTOM_PRESET_VALUE);
    formData.set("syncCustomAmount", "45");
    formData.set("syncCustomUnit", "minutes");
    expect(parseScheduleFormData(formData)).toEqual({ ok: true, intervalSeconds: 2700 });
  });
});
