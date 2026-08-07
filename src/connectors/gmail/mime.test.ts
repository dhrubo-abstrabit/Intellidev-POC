import { describe, expect, it } from "vitest";
import { extractPlainText, header, stripQuotedReply } from "./mime";
import { stripHtml } from "@/connectors/google_drive/text";
import type { GmailMessagePart } from "./mime";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("header", () => {
  it("matches case-insensitively — Gmail's header casing isn't stable", () => {
    const headers = [{ name: "Message-ID", value: "abc" }];
    expect(header(headers, "message-id")).toBe("abc");
    expect(header(headers, "MESSAGE-ID")).toBe("abc");
  });

  it("returns undefined when the header is absent", () => {
    expect(header([{ name: "Subject", value: "hi" }], "From")).toBeUndefined();
    expect(header(undefined, "From")).toBeUndefined();
  });
});

describe("extractPlainText", () => {
  it("prefers a top-level text/plain part", () => {
    const payload: GmailMessagePart = { mimeType: "text/plain", body: { data: b64url("hello world") } };
    expect(extractPlainText(payload, stripHtml)).toBe("hello world");
  });

  it("finds text/plain inside a multipart/alternative, preferring it over text/html", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>hi</p>") } },
        { mimeType: "text/plain", body: { data: b64url("plain hi") } },
      ],
    };
    expect(extractPlainText(payload, stripHtml)).toBe("plain hi");
  });

  it("falls back to a tag-stripped text/html part when no text/plain exists", () => {
    const payload: GmailMessagePart = { mimeType: "text/html", body: { data: b64url("<b>Hello</b> &amp; welcome") } };
    expect(extractPlainText(payload, stripHtml)).toBe("Hello & welcome");
  });

  it("skips a part carrying an attachmentId — an attached .txt file is not the body", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "att1", data: b64url("attachment content") } },
        { mimeType: "text/plain", body: { data: b64url("the real body") } },
      ],
    };
    expect(extractPlainText(payload, stripHtml)).toBe("the real body");
  });

  it("descends into nested multipart/related structures", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/related",
          parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64url("nested body") } }] }],
        },
      ],
    };
    expect(extractPlainText(payload, stripHtml)).toBe("nested body");
  });

  it("decodes base64url payloads containing '-' and '_' correctly (plain base64 would corrupt them)", () => {
    // These specific bytes base64url-encode to a string containing both '-'
    // and '_' (standard base64 would use '+' and '/' for the same bytes,
    // which plain Buffer.from(data, "base64") can't parse back correctly).
    const bytes = Buffer.from([0xff, 0xff, 0xfe, 0x3e, 0xfa]);
    const encoded = bytes.toString("base64url");
    expect(encoded).toMatch(/[-_]/); // sanity check: this case is actually being exercised
    const payload: GmailMessagePart = { mimeType: "text/plain", body: { data: encoded } };
    expect(extractPlainText(payload, stripHtml)).toBe(bytes.toString("utf8"));
  });

  it("returns undefined when there is no plain or html part", () => {
    const payload: GmailMessagePart = { mimeType: "multipart/mixed", parts: [{ mimeType: "image/png", body: { data: "xyz" } }] };
    expect(extractPlainText(payload, stripHtml)).toBeUndefined();
  });

  it("returns undefined for an undefined payload", () => {
    expect(extractPlainText(undefined, stripHtml)).toBeUndefined();
  });
});

describe("stripQuotedReply", () => {
  it("cuts at a Gmail/Apple-Mail style 'On ... wrote:' marker", () => {
    const text = "My reply here.\n\nOn Mon, Jan 5, 2026 at 3:00 PM, Alice <a@x.com> wrote:\n> original message";
    expect(stripQuotedReply(text)).toBe("My reply here.");
  });

  it("cuts at an Outlook '-----Original Message-----' marker", () => {
    const text = "My reply.\n-----Original Message-----\nFrom: bob@x.com";
    expect(stripQuotedReply(text)).toBe("My reply.");
  });

  it("cuts at an Outlook plain From/Sent/To header block", () => {
    const text = "My reply.\nFrom: Bob\nSent: Monday\nTo: Alice\n\noriginal text";
    expect(stripQuotedReply(text)).toBe("My reply.");
  });

  it("cuts at 3+ consecutive '>'-quoted lines", () => {
    const text = "My reply.\n> line one\n> line two\n> line three";
    expect(stripQuotedReply(text)).toBe("My reply.");
  });

  it("trims a trailing '-- \\n<signature>' block", () => {
    const text = "My reply.\n-- \nJohn Doe\nCEO";
    expect(stripQuotedReply(text)).toBe("My reply.");
  });

  it("leaves a message with no quote marker untouched", () => {
    expect(stripQuotedReply("Just a plain reply, nothing quoted.")).toBe("Just a plain reply, nothing quoted.");
  });
});
