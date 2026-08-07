import "server-only";
import { ConnectorAuthError } from "@/connectors/errors";
import type { FetchDeadline } from "@/connectors/types";

/**
 * Thrown instead of sleeping past a fetchSince run's remaining time budget.
 * Burning the last few seconds of a 45s budget asleep in a retry loop would
 * lose a partial page of results that could otherwise have been persisted —
 * every connector's pagination loop should catch this at its own boundary
 * and return what it already has with `hasMore: true`, not let it propagate
 * up as a hard failure.
 */
export class GoogleBudgetExhaustedError extends Error {
  constructor(message = "Ran out of time budget before the request/backoff could complete") {
    super(message);
    this.name = "GoogleBudgetExhaustedError";
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; domain?: string }>;
  };
}

// Drive and Gmail both overload HTTP 403 for two very different things:
// genuine permission denial (never retry) and quota/rate-limit (always
// retry). The `reason` field inside the error body is the only way to tell
// them apart — the top-level status code alone is not enough.
const RETRYABLE_403_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;

async function readErrorBody(res: Response): Promise<GoogleErrorBody | null> {
  try {
    return (await res.clone().json()) as GoogleErrorBody;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number, body: GoogleErrorBody | null): boolean {
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (status === 403) {
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
    return Boolean(reason && RETRYABLE_403_REASONS.has(reason));
  }
  return false;
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  // Exponential backoff with full jitter, capped — avoids every concurrent
  // sync retrying in lockstep against the same quota window.
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.random() * capped;
}

export interface GoogleFetchOptions {
  accessToken: string;
  deadline: FetchDeadline;
  maxAttempts?: number;
}

/**
 * Shared HTTP client for every Google API call across the Drive/Gmail/Chat
 * connectors. Retries 429, 5xx, and quota-flavored 403s with Retry-After (or
 * jittered exponential backoff); never retries a genuine 401 or a
 * permission-flavored 403. A 401 becomes ConnectorAuthError and propagates —
 * this module has no DB access and can't re-seal a refreshed token, so the
 * actual refresh happens on the NEXT run via services/sync/credentials.ts,
 * triggered by run-sync.ts clearing access_token_expires_at when it catches
 * this error.
 */
export async function googleFetch<T>(url: string, options: GoogleFetchOptions, init?: RequestInit): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.deadline.expired()) {
      throw new GoogleBudgetExhaustedError();
    }

    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        ...init?.headers,
      },
    });

    if (res.ok) {
      // 204/empty-body responses (e.g. some export calls) have nothing to parse.
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    if (res.status === 401) {
      throw new ConnectorAuthError(`Google API rejected the access token: ${url}`);
    }

    const body = await readErrorBody(res);
    if (!isRetryableStatus(res.status, body) || attempt === maxAttempts - 1) {
      const message = body?.error?.message ?? res.statusText;
      throw new Error(`Google API ${url} failed with ${res.status}: ${message}`);
    }

    const delay = backoffMs(attempt, res.headers.get("Retry-After"));
    if (delay > options.deadline.remainingMs()) {
      throw new GoogleBudgetExhaustedError();
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // Unreachable — the loop above always returns or throws — but keeps the
  // function's return type honest without a non-null assertion.
  throw new GoogleBudgetExhaustedError();
}
