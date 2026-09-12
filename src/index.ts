/**
 * jic — retry for LLM and HTTP APIs that actually respects Retry-After.
 *
 * Zero dependencies. Works anywhere `fetch` exists: Node 18+, Bun, Deno,
 * Cloudflare Workers, Vercel Edge.
 */

/** Status codes retried by default. */
export const DEFAULT_RETRY_STATUS: readonly number[] = [
  408, // Request Timeout
  409, // Conflict
  425, // Too Early
  429, // Too Many Requests
  500, 502, 503, 504,
];

export interface RetryInfo {
  /** 1 for the first retry, 2 for the second, and so on. */
  attempt: number;
  /** Milliseconds we are about to wait. */
  delay: number;
  /** Status code that triggered the retry, or undefined on a network error. */
  status?: number;
  /** The error thrown by `fn`, if it threw rather than returning a response. */
  error?: unknown;
  /** True when `delay` came from a server header rather than the backoff curve. */
  fromHeader: boolean;
}

export interface JicOptions {
  /** Retries after the initial call. Default 5. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles each attempt. Default 500. */
  baseDelay?: number;
  /** Ceiling for any single wait, in ms. Default 60_000. */
  maxDelay?: number;
  /** Randomise delays to avoid synchronised retries. Default true. */
  jitter?: boolean;
  /** Status codes to retry. Default DEFAULT_RETRY_STATUS. */
  retryOn?: readonly number[];
  /** Honour Retry-After / retry-after-ms headers. Default true. */
  respectRetryAfter?: boolean;
  /**
   * Reject header-provided delays longer than this, in ms, and fall back to
   * the backoff curve. Stops a server from parking you for an hour.
   * Default 120_000.
   */
  maxRetryAfter?: number;
  /** Retry on thrown network errors as well as bad statuses. Default true. */
  retryOnNetworkError?: boolean;
  /** Abort the whole operation, including waits. */
  signal?: AbortSignal;
  /** Called before each wait. Use it to log. */
  onRetry?: (info: RetryInfo) => void;
}

/** Thrown when every attempt has been used up. */
export class RetryLimitError extends Error {
  readonly attempts: number;
  readonly lastStatus?: number;
  readonly lastError?: unknown;

  constructor(attempts: number, lastStatus?: number, lastError?: unknown) {
    const detail = lastStatus !== undefined ? `HTTP ${lastStatus}` : 'network error';
    super(`jic: giving up after ${attempts} attempt(s), last failure: ${detail}`);
    this.name = 'RetryLimitError';
    this.attempts = attempts;
    this.lastStatus = lastStatus;
    this.lastError = lastError;
  }
}

type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

function readHeader(source: HeaderSource | undefined, name: string): string | null {
  if (!source) return null;

  if (typeof (source as { get?: unknown }).get === 'function') {
    return (source as { get(n: string): string | null }).get(name);
  }

  // Plain object: headers may be in any case.
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
    return value === undefined ? null : String(value);
  }
  return null;
}

/**
 * Read a retry delay out of response headers, in milliseconds.
 *
 * Handles the three forms that appear in the wild:
 *   retry-after-ms: 1500          (OpenAI, milliseconds, may be fractional)
 *   retry-after: 3                (RFC 9110, seconds)
 *   retry-after: Wed, 21 Oct 2026 07:28:00 GMT   (RFC 9110, HTTP date)
 *
 * Returns null when no usable value is present.
 *
 * The date form is the one that breaks naive code: `parseInt` on
 * "Wed, 21 Oct 2026 ..." returns NaN, and on "21 Oct 2026" it returns 21 —
 * the day of the month, silently treated as 21 seconds.
 */
export function parseRetryAfter(
  headers: HeaderSource | undefined,
  now: number = Date.now(),
): number | null {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms !== null) {
    const value = Number(ms.trim());
    if (Number.isFinite(value) && value >= 0) return value;
  }

  const raw = readHeader(headers, 'retry-after');
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '') return null;

  // Seconds: the whole value must be digits, so a date is never mistaken for one.
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function computeBackoff(attempt: number, base: number, max: number, jitter: boolean): number {
  const raw = Math.min(base * 2 ** (attempt - 1), max);
  if (!jitter) return raw;
  // Full jitter: uniform in [raw/2, raw]. Keeps some floor while spreading load.
  return raw / 2 + Math.random() * (raw / 2);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Call `fn` and retry it when the server says to.
 *
 *   const res = await jic(() => fetch(url, opts));
 *
 * `fn` receives the attempt number, starting at 0, so you can vary the call.
 * The resolved response is returned untouched — jic never reads the body.
 */
export async function jic(
  fn: (attempt: number) => Promise<Response>,
  options: JicOptions = {},
): Promise<Response> {
  const {
    maxRetries = 5,
    baseDelay = 500,
    maxDelay = 60_000,
    jitter = true,
    retryOn = DEFAULT_RETRY_STATUS,
    respectRetryAfter = true,
    maxRetryAfter = 120_000,
    retryOnNetworkError = true,
    signal,
    onRetry,
  } = options;

  if (maxRetries < 0) throw new TypeError('jic: maxRetries must be >= 0');

  const retryable = new Set(retryOn);
  let lastStatus: number | undefined;
  let lastError: unknown;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');

    let response: Response | undefined;
    lastStatus = undefined;
    lastError = undefined;

    try {
      response = await fn(attempt);
      if (!retryable.has(response.status)) return response;
      lastStatus = response.status;
    } catch (error) {
      if (!retryOnNetworkError) throw error;
      // An abort is a decision, not a failure to retry.
      if (signal?.aborted) throw error;
      lastError = error;
    }

    if (attempt >= maxRetries) {
      if (response) return response; // hand back the failing response, don't hide it
      throw new RetryLimitError(attempt + 1, lastStatus, lastError);
    }

    const next = attempt + 1;
    let delay = computeBackoff(next, baseDelay, maxDelay, jitter);
    let fromHeader = false;

    if (respectRetryAfter && response) {
      const advertised = parseRetryAfter(response.headers);
      if (advertised !== null && advertised <= maxRetryAfter) {
        delay = advertised;
        fromHeader = true;
      }
    }

    onRetry?.({ attempt: next, delay, status: lastStatus, error: lastError, fromHeader });
    await wait(delay, signal);
  }
}

export default jic;
