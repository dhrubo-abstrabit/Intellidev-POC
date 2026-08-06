import { describe, expect, it } from "vitest";
import { parseDriveSourceUrl } from "./source-url";

describe("parseDriveSourceUrl", () => {
  it("accepts a folder URL", () => {
    expect(parseDriveSourceUrl("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx")).toEqual({
      ok: true,
      id: "1AbCdEfGhIjKlMnOpQrStUvWx",
    });
  });

  it("accepts a folder URL with a /u/<n>/ account-index segment", () => {
    expect(parseDriveSourceUrl("https://drive.google.com/drive/u/2/folders/1AbCdEfGhIjKlMnOpQrStUvWx")).toEqual({
      ok: true,
      id: "1AbCdEfGhIjKlMnOpQrStUvWx",
    });
  });

  it("accepts a folder URL with query params (resourcekey, usp) and a trailing slash", () => {
    expect(
      parseDriveSourceUrl("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWx?usp=sharing&resourcekey=xyz/"),
    ).toEqual({ ok: true, id: "1AbCdEfGhIjKlMnOpQrStUvWx" });
  });

  it("accepts a bare id", () => {
    expect(parseDriveSourceUrl("1AbCdEfGhIjKlMnOpQrStUvWx")).toEqual({ ok: true, id: "1AbCdEfGhIjKlMnOpQrStUvWx" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseDriveSourceUrl("  1AbCdEfGhIjKlMnOpQrStUvWx  ")).toEqual({ ok: true, id: "1AbCdEfGhIjKlMnOpQrStUvWx" });
  });

  it("rejects an empty string", () => {
    expect(parseDriveSourceUrl("   ").ok).toBe(false);
  });

  it("rejects /drive/u/0/my-drive", () => {
    const result = parseDriveSourceUrl("https://drive.google.com/drive/u/0/my-drive");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/specific folder/i);
  });

  it("rejects /drive/shared-drives", () => {
    expect(parseDriveSourceUrl("https://drive.google.com/drive/shared-drives").ok).toBe(false);
  });

  it("rejects a single-file URL (/file/d/<id>)", () => {
    const result = parseDriveSourceUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWx/view");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/single file/i);
  });

  it("rejects a Google Docs document URL", () => {
    expect(parseDriveSourceUrl("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWx/edit").ok).toBe(false);
  });

  it("rejects an id containing characters outside the safe charset, including injection attempts", () => {
    // The id is interpolated into a Drive `q` string — a stray quote could
    // break out of the quoted literal (query.ts's escaping is the second
    // layer of defense, this charset gate is the first).
    expect(parseDriveSourceUrl("abc'; DROP TABLE").ok).toBe(false);
    expect(parseDriveSourceUrl('abc" or 1=1').ok).toBe(false);
  });

  it("rejects an id shorter than the minimum length", () => {
    expect(parseDriveSourceUrl("short").ok).toBe(false);
  });
});
