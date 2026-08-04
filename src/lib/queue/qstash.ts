import "server-only";
import { Client } from "@upstash/qstash";
import { queueEnv, publicEnv } from "@/lib/env";

let client: Client | undefined;

function getClient(): Client {
  if (client) return client;
  const env = queueEnv();
  client = new Client({ baseUrl: env.QSTASH_URL, token: env.QSTASH_TOKEN });
  return client;
}

/**
 * Publish a JSON job to one of our own `/api/jobs/*` routes. `path` is
 * resolved against NEXT_PUBLIC_APP_URL, so QStash must be able to reach that
 * URL over the public internet — this only works once deployed (or tunneled)
 * and never against `localhost` directly, since Upstash's servers are what
 * make the callback, not this process.
 */
export async function publishJob(path: string, body: unknown, options?: { retries?: number }): Promise<string> {
  const url = new URL(path, publicEnv().NEXT_PUBLIC_APP_URL).toString();
  const result = await getClient().publishJSON({ url, body, retries: options?.retries ?? 3 });
  return result.messageId;
}
