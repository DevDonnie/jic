# jic

Retry for LLM and HTTP APIs that actually respects `Retry-After`.

Zero dependencies. Works anywhere `fetch` exists: Node 18+, Bun, Deno, Cloudflare Workers, Vercel Edge.

```bash
npm install @donniedev/jic
```

```js
import { jic } from '@donniedev/jic';

const res = await jic(() => fetch('https://api.openai.com/v1/chat/completions', options));
```

That's it. 429s and 5xx are retried with exponential backoff, and when the server tells you how long to wait, `jic` waits exactly that long instead of guessing.

## The bug this exists for

`Retry-After` has two legal forms. This one is fine:

```
Retry-After: 3
```

This one is also legal:

```
Retry-After: Wed, 21 Oct 2026 07:28:00 GMT
```

Most hand-rolled retry code does `parseInt(res.headers.get('retry-after'))`. On the date form that returns `NaN`, or worse — on a header without the weekday, it returns the day of the month and your code waits 21 seconds because today is the 21st. `jic` parses both forms correctly, and also reads `retry-after-ms`, which OpenAI sends and which most retry libraries ignore entirely.

## API

### `jic(fn, options?)`

Calls `fn` and retries it on retryable failures. `fn` receives the attempt number, starting at `0`. The response is returned untouched — `jic` never reads the body, so streaming still works.

If retries run out on a bad status, the failing response is returned rather than thrown, so you can inspect it. If retries run out on a thrown network error, a `RetryLimitError` is thrown.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | `5` | Retries after the initial call |
| `baseDelay` | `500` | First backoff delay in ms, doubles each attempt |
| `maxDelay` | `60000` | Ceiling for a single backoff wait |
| `jitter` | `true` | Randomise delays into `[raw/2, raw]` |
| `retryOn` | `[408, 409, 425, 429, 500, 502, 503, 504]` | Status codes to retry |
| `respectRetryAfter` | `true` | Honour `Retry-After` / `retry-after-ms` |
| `maxRetryAfter` | `120000` | Reject longer header delays, fall back to backoff |
| `retryOnNetworkError` | `true` | Retry thrown errors as well as bad statuses |
| `signal` | — | `AbortSignal`, cancels the call and any pending wait |
| `onRetry` | — | `(info) => void`, called before each wait |

```js
const res = await jic(() => fetch(url, opts), {
  maxRetries: 8,
  onRetry: ({ attempt, delay, status, fromHeader }) => {
    console.warn(`attempt ${attempt}: HTTP ${status}, waiting ${delay}ms${fromHeader ? ' (server said so)' : ''}`);
  },
});
```

### `parseRetryAfter(headers, now?)`

Returns the advertised delay in milliseconds, or `null` if there isn't a usable one. Accepts a `Headers` object or a plain object with any capitalisation. Exported on its own because it's useful outside a retry loop.

```js
parseRetryAfter(new Headers({ 'retry-after': '3' }));                         // 3000
parseRetryAfter(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:30 GMT' })); // ms until then
parseRetryAfter({ 'Retry-After-Ms': '1500' });                                // 1500
```

### `RetryLimitError`

Thrown when every attempt failed with a network error. Carries `attempts`, `lastStatus` and `lastError`.

### `DEFAULT_RETRY_STATUS`

The default status list, exported so you can extend it:

```js
import { jic, DEFAULT_RETRY_STATUS } from '@donniedev/jic';

await jic(fn, { retryOn: [...DEFAULT_RETRY_STATUS, 522] });
```

## Cancelling

`signal` aborts the pending wait too, not just the request — so an abort takes effect immediately instead of after the current backoff finishes.

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 5000);

await jic(() => fetch(url, { signal: ac.signal }), { signal: ac.signal });
```

## Why not `p-retry`

`p-retry` is excellent and more general — it retries any promise. `jic` is narrower on purpose: it knows it's wrapping an HTTP response, so it reads the server's own guidance instead of only applying a backoff curve. If you aren't dealing with `Retry-After`, use `p-retry`.

Note that the official OpenAI and Anthropic SDKs already handle retries internally. `jic` is for when you're calling those APIs with raw `fetch`, which is common on edge runtimes where the SDKs don't fit.

## License

MIT
