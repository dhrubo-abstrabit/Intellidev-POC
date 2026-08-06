import { describe, expect, it } from "vitest";
import { parseChatSpaceInput } from "./space-url";

describe("parseChatSpaceInput", () => {
  it("accepts an already-normalized resource name", () => {
    expect(parseChatSpaceInput("spaces/AAAAAAAAAAA")).toEqual({ ok: true, spaceName: "spaces/AAAAAAAAAAA" });
  });

  it("accepts a mail.google.com Chat URL with a hash fragment", () => {
    expect(parseChatSpaceInput("https://mail.google.com/chat/u/0/#chat/space/AAAAAAAAAAA")).toEqual({
      ok: true,
      spaceName: "spaces/AAAAAAAAAAA",
    });
  });

  it("accepts a chat.google.com/room URL", () => {
    expect(parseChatSpaceInput("https://chat.google.com/room/AAAAAAAAAAA")).toEqual({
      ok: true,
      spaceName: "spaces/AAAAAAAAAAA",
    });
  });

  it("accepts the current chat.google.com/app/chat URL shape (regression: real link that failed)", () => {
    expect(parseChatSpaceInput("https://chat.google.com/app/chat/AAQAD2wTsvM")).toEqual({
      ok: true,
      spaceName: "spaces/AAQAD2wTsvM",
    });
  });

  it("accepts a trailing slash or query string after the id", () => {
    expect(parseChatSpaceInput("https://chat.google.com/app/chat/AAQAD2wTsvM/")).toEqual({
      ok: true,
      spaceName: "spaces/AAQAD2wTsvM",
    });
    expect(parseChatSpaceInput("https://chat.google.com/app/chat/AAQAD2wTsvM?authuser=0")).toEqual({
      ok: true,
      spaceName: "spaces/AAQAD2wTsvM",
    });
  });

  it("accepts a bare id", () => {
    expect(parseChatSpaceInput("AAAAAAAAAAA")).toEqual({ ok: true, spaceName: "spaces/AAAAAAAAAAA" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseChatSpaceInput("  AAAAAAAAAAA  ")).toEqual({ ok: true, spaceName: "spaces/AAAAAAAAAAA" });
  });

  it("rejects an empty string", () => {
    expect(parseChatSpaceInput("   ").ok).toBe(false);
  });

  it("rejects a URL with no space/room segment", () => {
    expect(parseChatSpaceInput("https://mail.google.com/chat/u/0/").ok).toBe(false);
  });

  it("rejects a bare id containing characters outside the safe charset", () => {
    // Interpolated into a Chat API request path — a slash or quote here
    // could smuggle in an unintended path segment.
    expect(parseChatSpaceInput("abc/def").ok).toBe(false);
    expect(parseChatSpaceInput("abc'; DROP").ok).toBe(false);
  });

  it("rejects an id shorter than the minimum length", () => {
    expect(parseChatSpaceInput("ab").ok).toBe(false);
  });
});
