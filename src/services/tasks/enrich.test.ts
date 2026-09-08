import { describe, expect, it, vi } from "vitest";
import { linkAndEnrichTaskSource, type LinkTaskSourceArgs } from "./enrich";
import type { LLMProvider, TaskEnrichmentResult } from "@/lib/llm/types";
import type { createServiceClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** A minimal stand-in for the subset of the Supabase query builder chain
 * enrich.ts actually calls — chainable via .eq()/.select(), terminal via
 * .single() or plain await (`then`). Cast to ServiceClient at the call
 * site: this codebase has no narrower service-client interface to type
 * against, and enrich.ts is written against the real client's shape. */
function chainable(result: unknown) {
  const node = {
    eq: () => node,
    select: () => node,
    single: () => Promise.resolve(result),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return node;
}

interface FakeServiceOptions {
  taskSourcesInsertError?: { code: string; message: string } | null;
  llmRunsInsertResult?: { data: { id: string } | null; error: unknown };
}

function createFakeService(opts: FakeServiceOptions = {}) {
  const calls = {
    taskSourcesInsert: [] as Record<string, unknown>[],
    llmRunsInsert: [] as Record<string, unknown>[],
    tasksUpdate: [] as Record<string, unknown>[],
    llmRunsUpdate: [] as Record<string, unknown>[],
  };

  const service = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          if (table === "task_sources") {
            calls.taskSourcesInsert.push(row);
            return chainable({ error: opts.taskSourcesInsertError ?? null });
          }
          if (table === "llm_runs") {
            calls.llmRunsInsert.push(row);
            return chainable(opts.llmRunsInsertResult ?? { data: { id: "run-1" }, error: null });
          }
          throw new Error(`fake service: unexpected insert on "${table}"`);
        },
        update(patch: Record<string, unknown>) {
          if (table === "task_sources") return chainable({ error: null });
          if (table === "tasks") {
            calls.tasksUpdate.push(patch);
            return chainable({ error: null });
          }
          if (table === "llm_runs") {
            calls.llmRunsUpdate.push(patch);
            return chainable({ error: null });
          }
          throw new Error(`fake service: unexpected update on "${table}"`);
        },
      };
    },
  };

  return { service: service as unknown as ServiceClient, calls };
}

function createFakeProvider(enrichTaskDescription: LLMProvider["enrichTaskDescription"]): LLMProvider {
  return {
    id: "fake",
    model: "fake-model",
    generateActionItems: vi.fn(),
    consolidateActionItems: vi.fn(),
    enrichTaskDescription,
  };
}

function enrichmentResult(overrides: Partial<TaskEnrichmentResult["enrichment"]> = {}): TaskEnrichmentResult {
  return {
    enrichment: { changed: true, description: "Updated: turns out it's a race condition.", ...overrides },
    usage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    model: "fake-model",
    prompt: {},
    response: {},
  };
}

const baseArgs: LinkTaskSourceArgs = {
  tenantId: "tenant-1",
  clientSpaceId: "space-1",
  taskId: "task-1",
  normalizedEventId: "event-1",
  chunkId: "chunk-1",
  linkedBy: "user-1",
  task: { title: "Fix flaky test", kind: "action", description: "It fails sometimes." },
  project: { id: "proj-1", name: "Acme Dashboard", timezone: "UTC" },
  newContext: { sourceKind: "normalized_event", content: "some content", occurredAt: "2026-08-14T00:00:00Z" },
};

describe("linkAndEnrichTaskSource", () => {
  it("links and updates the description on a successful, changed enrichment", async () => {
    const { service, calls } = createFakeService();
    const provider = createFakeProvider(vi.fn().mockResolvedValue(enrichmentResult()));

    const result = await linkAndEnrichTaskSource(service, provider, baseArgs);

    expect(result.status).toBe("linked");
    expect(calls.tasksUpdate).toHaveLength(1);
    expect(calls.tasksUpdate[0].description).toBe("Updated: turns out it's a race condition.");
    expect(calls.llmRunsUpdate.at(-1)?.status).toBe("succeeded");
  });

  it("links but leaves the description untouched when the model declines (changed:false)", async () => {
    const { service, calls } = createFakeService();
    const provider = createFakeProvider(vi.fn().mockResolvedValue(enrichmentResult({ changed: false, description: baseArgs.task.description! })));

    const result = await linkAndEnrichTaskSource(service, provider, baseArgs);

    expect(result.status).toBe("linked_no_change");
    expect(calls.tasksUpdate).toHaveLength(0);
  });

  it("treats an identical description as no-op even when the model claims changed:true", async () => {
    const { service, calls } = createFakeService();
    const provider = createFakeProvider(vi.fn().mockResolvedValue(enrichmentResult({ changed: true, description: baseArgs.task.description! })));

    const result = await linkAndEnrichTaskSource(service, provider, baseArgs);

    expect(result.status).toBe("linked_no_change");
    expect(calls.tasksUpdate).toHaveLength(0);
  });

  it("keeps the link and leaves the description untouched when the LLM call throws", async () => {
    const { service, calls } = createFakeService();
    const provider = createFakeProvider(vi.fn().mockRejectedValue(new Error("provider unavailable")));

    const result = await linkAndEnrichTaskSource(service, provider, baseArgs);

    expect(result.status).toBe("linked_no_rewrite");
    expect(calls.taskSourcesInsert).toHaveLength(1); // the link itself was written
    expect(calls.tasksUpdate).toHaveLength(0); // description never touched
    expect(calls.llmRunsUpdate.at(-1)?.status).toBe("failed");
  });

  it("returns already_linked and never calls the provider on a duplicate link (double-click guard)", async () => {
    const { service, calls } = createFakeService({ taskSourcesInsertError: { code: "23505", message: "duplicate key" } });
    const enrichTaskDescription = vi.fn();
    const provider = createFakeProvider(enrichTaskDescription);

    const result = await linkAndEnrichTaskSource(service, provider, baseArgs);

    expect(result.status).toBe("already_linked");
    expect(enrichTaskDescription).not.toHaveBeenCalled();
    expect(calls.llmRunsInsert).toHaveLength(0); // no run created for a rejected duplicate
  });
});
