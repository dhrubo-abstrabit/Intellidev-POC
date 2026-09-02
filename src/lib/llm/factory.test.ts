import { afterEach, describe, expect, it, vi } from "vitest";
import { getLLMProvider } from "./factory";
import { serverEnv } from "@/lib/env";

const REQUIRED_NON_LLM_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  CRON_SECRET: "test-cron-secret",
  NANGO_SERVER_URL: "https://nango.example.test",
  NANGO_SECRET_KEY: "test-nango-secret",
};

function stubBaseEnv() {
  for (const [key, value] of Object.entries(REQUIRED_NON_LLM_ENV)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getLLMProvider", () => {
  it("defaults to anthropic when LLM_PROVIDER is unset and ANTHROPIC_API_KEY is present", () => {
    vi.stubEnv("LLM_PROVIDER", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    // NOTE: LLM_PROVIDER's default is "anthropic" as of this commit. A later
    // change flips the app-wide default to "openai" once the OpenAI path is
    // validated in production — this test's expectation flips with it.
    expect(getLLMProvider().id).toBe("anthropic");
  });

  it("selects openai when LLM_PROVIDER=openai and OPENAI_API_KEY is present, without requiring ANTHROPIC_API_KEY", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const provider = getLLMProvider();
    expect(provider.id).toBe("openai");
    expect(provider.model).toBe("gpt-5.6-luna");
  });

  it("throws naming ANTHROPIC_API_KEY when LLM_PROVIDER=anthropic and it's missing", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    expect(() => getLLMProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws naming OPENAI_API_KEY when LLM_PROVIDER=openai and it's missing", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    expect(() => getLLMProvider()).toThrow(/OPENAI_API_KEY/);
  });

  it("treats an empty-string ANTHROPIC_API_KEY as absent, not as a validation failure, under LLM_PROVIDER=openai", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => getLLMProvider()).not.toThrow();
    expect(getLLMProvider().id).toBe("openai");
  });

  it("throws for an unknown LLM_PROVIDER value", () => {
    vi.stubEnv("LLM_PROVIDER", "gemini");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    expect(() => getLLMProvider()).toThrow();
  });
});

describe("serverEnv — regression guard on the llmSchemaBase/.shape composition", () => {
  it("still parses successfully with every concern's vars present", () => {
    stubBaseEnv();
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    expect(() => serverEnv()).not.toThrow();
  });
});
