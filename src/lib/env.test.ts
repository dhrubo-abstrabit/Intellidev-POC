import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.resetModules();
});

describe("appUrl", () => {
  it("uses NEXT_PUBLIC_APP_URL verbatim when it's set", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.stubEnv("VERCEL_URL", "some-preview-deployment.vercel.app");
    const { appUrl } = await import("./env");
    // NEXT_PUBLIC_APP_URL wins even when VERCEL_URL is also present —
    // Production always sets it explicitly and must never fall through to
    // the internal *.vercel.app alias.
    expect(appUrl()).toBe("https://app.example.test");
  });

  it("falls back to VERCEL_URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    vi.stubEnv("VERCEL_URL", "my-app-git-feature-abc123.vercel.app");
    const { appUrl } = await import("./env");
    expect(appUrl()).toBe("https://my-app-git-feature-abc123.vercel.app");
  });

  it("throws a clear error when neither is available", async () => {
    const { appUrl } = await import("./env");
    expect(() => appUrl()).toThrow(/NEXT_PUBLIC_APP_URL is not set/);
  });
});
