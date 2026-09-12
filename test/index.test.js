import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jic, parseRetryAfter, RetryLimitError } from '../dist/esm/index.js';

const res = (status, headers = {}) => new Response(null, { status, headers });

test('parseRetryAfter: seconds', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '3' })), 3000);
});

test('parseRetryAfter: retry-after-ms wins and allows fractions', () => {
  const h = new Headers({ 'retry-after-ms': '1500.5', 'retry-after': '60' });
  assert.equal(parseRetryAfter(h), 1500.5);
});

test('parseRetryAfter: HTTP date is not parsed as a number', () => {
  const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
  const h = new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:30 GMT' });
  assert.equal(parseRetryAfter(h, now), 30_000);
  // the naive version would have produced 21 seconds from the day of the month
  assert.notEqual(parseRetryAfter(h, now), 21_000);
});

test('parseRetryAfter: date in the past clamps to zero', () => {
  const now = Date.parse('Wed, 21 Oct 2026 08:00:00 GMT');
  const h = new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:00:00 GMT' });
  assert.equal(parseRetryAfter(h, now), 0);
});

test('parseRetryAfter: missing, empty and junk values', () => {
  assert.equal(parseRetryAfter(new Headers()), null);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '   ' })), null);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': 'soon' })), null);
  assert.equal(parseRetryAfter(undefined), null);
});

test('parseRetryAfter: plain object headers, any case', () => {
  assert.equal(parseRetryAfter({ 'Retry-After': '2' }), 2000);
  assert.equal(parseRetryAfter({ 'RETRY-AFTER-MS': '250' }), 250);
});

test('returns a successful response without retrying', async () => {
  let calls = 0;
  const out = await jic(async () => { calls++; return res(200); });
  assert.equal(out.status, 200);
  assert.equal(calls, 1);
});

test('does not retry a 400', async () => {
  let calls = 0;
  const out = await jic(async () => { calls++; return res(400); });
  assert.equal(out.status, 400);
  assert.equal(calls, 1);
});

test('retries a 429 then succeeds', async () => {
  let calls = 0;
  const out = await jic(async () => (++calls < 3 ? res(429) : res(200)), { baseDelay: 1 });
  assert.equal(out.status, 200);
  assert.equal(calls, 3);
});

test('honours retry-after-ms over the backoff curve', async () => {
  const delays = [];
  let calls = 0;
  await jic(
    async () => (++calls < 2 ? res(429, { 'retry-after-ms': '40' }) : res(200)),
    { baseDelay: 5000, onRetry: (i) => delays.push(i) },
  );
  assert.equal(delays.length, 1);
  assert.equal(delays[0].delay, 40);
  assert.equal(delays[0].fromHeader, true);
});

test('ignores an absurd Retry-After and falls back to backoff', async () => {
  const delays = [];
  let calls = 0;
  await jic(
    async () => (++calls < 2 ? res(429, { 'retry-after': '3600' }) : res(200)),
    { baseDelay: 2, jitter: false, maxRetryAfter: 1000, onRetry: (i) => delays.push(i) },
  );
  assert.equal(delays[0].fromHeader, false);
  assert.equal(delays[0].delay, 2);
});

test('backoff doubles and respects maxDelay', async () => {
  const delays = [];
  let calls = 0;
  await jic(
    async () => (++calls < 5 ? res(503) : res(200)),
    { baseDelay: 10, maxDelay: 35, jitter: false, onRetry: (i) => delays.push(i.delay) },
  );
  assert.deepEqual(delays, [10, 20, 35, 35]);
});

test('jitter keeps delays inside [raw/2, raw]', async () => {
  const delays = [];
  let calls = 0;
  await jic(
    async () => (++calls < 4 ? res(503) : res(200)),
    { baseDelay: 100, jitter: true, onRetry: (i) => delays.push(i.delay) },
  );
  assert.ok(delays[0] >= 50 && delays[0] <= 100, `got ${delays[0]}`);
  assert.ok(delays[1] >= 100 && delays[1] <= 200, `got ${delays[1]}`);
});

test('returns the failing response once retries run out', async () => {
  let calls = 0;
  const out = await jic(async () => { calls++; return res(429); }, { maxRetries: 2, baseDelay: 1 });
  assert.equal(out.status, 429);
  assert.equal(calls, 3); // initial call plus two retries
});

test('retries network errors then throws RetryLimitError', async () => {
  let calls = 0;
  await assert.rejects(
    () => jic(async () => { calls++; throw new TypeError('fetch failed'); },
      { maxRetries: 2, baseDelay: 1 }),
    (err) => {
      assert.ok(err instanceof RetryLimitError);
      assert.equal(err.attempts, 3);
      assert.ok(err.lastError instanceof TypeError);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('retryOnNetworkError false rethrows immediately', async () => {
  let calls = 0;
  await assert.rejects(
    () => jic(async () => { calls++; throw new Error('boom'); }, { retryOnNetworkError: false }),
    /boom/,
  );
  assert.equal(calls, 1);
});

test('maxRetries 0 makes a single attempt', async () => {
  let calls = 0;
  const out = await jic(async () => { calls++; return res(500); }, { maxRetries: 0 });
  assert.equal(out.status, 500);
  assert.equal(calls, 1);
});

test('abort during the wait stops everything', async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = jic(async () => { calls++; return res(429); },
    { baseDelay: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(new Error('cancelled')), 20);
  await assert.rejects(p, /cancelled/);
  assert.equal(calls, 1);
});

test('custom retryOn list', async () => {
  let calls = 0;
  const out = await jic(async () => (++calls < 2 ? res(418) : res(200)),
    { retryOn: [418], baseDelay: 1 });
  assert.equal(out.status, 200);
  assert.equal(calls, 2);
});

test('fn receives the attempt number', async () => {
  const seen = [];
  let calls = 0;
  await jic(async (attempt) => { seen.push(attempt); return ++calls < 3 ? res(429) : res(200); },
    { baseDelay: 1 });
  assert.deepEqual(seen, [0, 1, 2]);
});
