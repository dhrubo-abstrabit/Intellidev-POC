import "server-only";
import { llmEnv } from "@/lib/env";
import { anthropicProvider } from "./anthropic";
import type { LLMProvider } from "./types";

export function getLLMProvider(): LLMProvider {
  const { LLM_PROVIDER } = llmEnv();
  switch (LLM_PROVIDER) {
    case "anthropic":
      return anthropicProvider;
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${LLM_PROVIDER}`);
  }
}
