import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { createOpenAIProvider, OPENAI_MODEL } from "./openai";
import type { ActionItemContext, DraftForConsolidation } from "./types";

const baseContext: ActionItemContext = {
  project: { id: "proj-1", name: "Acme Dashboard", description: "Internal ops tooling", timezone: "UTC" },
  openActionItems: [{ id: "t-1", title: "Fix flaky test", kind: "action", priority: "high" }],
  recentSummaries: [],
  newEvents: [{ id: "e-1", type: "slack.message", occurredAt: "2026-08-14T00:00:00Z", title: "checkout broke again" }],
};

function fakeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: "completed",
    output: [],
    output_parsed: { items: [] },
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 1050,
    },
    ...overrides,
  };
}

function fakeClient(parseImpl: (params: Record<string, unknown>) => unknown): OpenAI {
  return {
    responses: {
      parse: vi.fn(parseImpl),
    },
  } as unknown as OpenAI;
}

describe("createOpenAIProvider — request shape", () => {
  it("extraction call uses the right model, low effort, store:false, and the output-token cap", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = fakeClient((params) => {
      capturedParams = params;
      return fakeResponse();
    });
    const provider = createOpenAIProvider(client);
    await provider.generateActionItems(baseContext);

    expect(capturedParams?.model).toBe(OPENAI_MODEL);
    expect(capturedParams?.reasoning).toEqual({ effort: "low" });
    expect(capturedParams?.store).toBe(false);
    expect(capturedParams?.max_output_tokens).toBe(16_000);
    expect(capturedParams?.prompt_cache_key).toContain("proj-1");
  });

  it("consolidation call uses medium effort", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = fakeClient((params) => {
      capturedParams = params;
      return fakeResponse({ output_parsed: { groups: [] } });
    });
    const provider = createOpenAIProvider(client);
    const drafts: DraftForConsolidation[] = [];
    await provider.consolidateActionItems(baseContext.openActionItems, drafts);

    expect(capturedParams?.reasoning).toEqual({ effort: "medium" });
  });

  it("uses a strict json_schema text format with a name", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = fakeClient((params) => {
      capturedParams = params;
      return fakeResponse();
    });
    await createOpenAIProvider(client).generateActionItems(baseContext);

    const format = (capturedParams?.text as { format?: { type?: string; strict?: boolean; name?: string } })?.format;
    expect(format?.type).toBe("json_schema");
    expect(format?.strict).toBe(true);
    expect(format?.name).toBeTruthy();
  });

  it("instructions include the OPEN ITEMS section from the project profile", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = fakeClient((params) => {
      capturedParams = params;
      return fakeResponse();
    });
    await createOpenAIProvider(client).generateActionItems(baseContext);

    expect(capturedParams?.instructions as string).toContain("OPEN ITEMS");
    expect(capturedParams?.instructions as string).toContain("Fix flaky test");
  });
});

describe("createOpenAIProvider — usage mapping", () => {
  it("subtracts cached and cache-write tokens from input_tokens to get promptTokens", async () => {
    const client = fakeClient(() => fakeResponse());
    const result = await createOpenAIProvider(client).generateActionItems(baseContext);

    // input_tokens: 1000, cached_tokens: 400, cache_write_tokens: 100
    expect(result.usage).toEqual({
      promptTokens: 500,
      cacheReadTokens: 400,
      cacheCreationTokens: 100,
      completionTokens: 50,
    });
  });

  it("never goes negative, and defaults missing usage fields to zero", async () => {
    const client = fakeClient(() => fakeResponse({ usage: undefined }));
    const result = await createOpenAIProvider(client).generateActionItems(baseContext);
    expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({ promptTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, completionTokens: 0 });
  });
});

describe("createOpenAIProvider — error handling", () => {
  it("throws, naming the reason, when the response is incomplete", async () => {
    const client = fakeClient(() =>
      fakeResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_parsed: null }),
    );
    await expect(createOpenAIProvider(client).generateActionItems(baseContext)).rejects.toThrow(/incomplete.*max_output_tokens/i);
  });

  it("throws with the refusal text when the model refuses", async () => {
    const client = fakeClient(() =>
      fakeResponse({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot help with that" }] }],
        output_parsed: null,
      }),
    );
    await expect(createOpenAIProvider(client).generateActionItems(baseContext)).rejects.toThrow(/cannot help with that/);
  });

  it("throws when output_parsed is missing", async () => {
    const client = fakeClient(() => fakeResponse({ output_parsed: null }));
    await expect(createOpenAIProvider(client).generateActionItems(baseContext)).rejects.toThrow(/did not return parseable/i);
  });
});

describe("createOpenAIProvider — llm_runs logging fields", () => {
  it("populates prompt and response for later persistence", async () => {
    const client = fakeClient(() => fakeResponse());
    const result = await createOpenAIProvider(client).generateActionItems(baseContext);
    expect(result.prompt).toBeTruthy();
    expect(result.response).toBeTruthy();
    expect(result.model).toBe(OPENAI_MODEL);
  });
});
