// Regressions Codex found in the core (paging, aborts, body reads).
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionError, ZapSMTP } from '../src/index.js';

afterEach(() => vi.useRealTimers());

const list = (data: object[], more = true) => new Response(JSON.stringify({ object: 'list', data, has_more: more }));
const client = (fetch: unknown, opts: object = {}) => new ZapSMTP('test-key', { fetch: fetch as typeof globalThis.fetch, baseUrl: 'https://api.test/v1', ...opts });
const query = (f: ReturnType<typeof vi.fn>, call: number) => new URL(String(f.mock.calls[call][0])).searchParams;

it('hasNextPage only inspects the page and does not issue a request', async () => {
  const fetch = vi.fn(async () => list([{ id: 'email-1' }]));
  const page = await client(fetch).emails.list();
  expect(page.hasNextPage()).toBe(true);
  expect(page.hasNextPage()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('conversation paging uses the last activity time and the tie-breaking thread id', async () => {
  const last = { id: '019aaa00-0000-7000-8000-000000000001', last_message_at: '2026-10-28T08:00:00Z' };
  const fetch = vi.fn(async (_u: unknown, _i?: unknown) => list([last]));
  const page = await client(fetch).threads.list({ limit: 1, unread: true });
  await page.getNextPage();
  const q = query(fetch, 1);
  expect(q.get('before')).toBe(last.last_message_at);
  expect(q.get('before_id')).toBe(last.id);
  expect(q.get('unread')).toBe('true');
  const bare = await client(vi.fn(async () => list([{ id: 'x' }]))).threads.list();
  expect(bare.hasNextPage()).toBe(false); // no last_message_at: nothing to ask for
});

it('received attachments page forward after the last id', async () => {
  const fetch = vi.fn(async (_u: unknown, _i?: unknown) => list([{ id: 'a1' }, { id: 'a2' }]));
  const page = await client(fetch).emails.receiving.attachments.list('m1', { limit: 2 });
  await page.getNextPage();
  expect(query(fetch, 1).get('after')).toBe('a2');
  expect((await client(vi.fn(async () => list([]))).emails.receiving.attachments.list('m1')).hasNextPage()).toBe(false);
});

it('logs page back with before, or forward after the newest entry when paged with after', async () => {
  const back = vi.fn(async (_u: unknown, _i?: unknown) => list([{ id: 'l3' }, { id: 'l2' }]));
  await (await client(back).logs.list()).getNextPage();
  expect(query(back, 1).get('before')).toBe('l2');
  const fwd = vi.fn(async (_u: unknown, _i?: unknown) => list([{ id: 'l9' }, { id: 'l8' }]));
  await (await client(fwd).logs.list({ after: 'l7' })).getNextPage();
  expect(query(fwd, 1).get('after')).toBe('l9');
  expect(query(fwd, 1).get('before')).toBeNull();
  expect((await client(vi.fn(async () => list([]))).logs.list({ after: 'l7' })).hasNextPage()).toBe(false);
  expect((await client(vi.fn(async () => list([]))).logs.list()).hasNextPage()).toBe(false);
  expect((await client(vi.fn(async () => list([]))).emails.receiving.list()).hasNextPage()).toBe(false);
});

it('an already aborted signal prevents the request from being sent', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  const controller = new AbortController();
  const reason = new Error('caller cancelled before sending');
  controller.abort(reason);
  expect(await client(fetch).emails.get('email-1', { signal: controller.signal }).catch((e: unknown) => e)).toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
  const bare = { aborted: true, reason: undefined, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
  expect(await client(fetch).emails.get('email-1', { signal: bare }).catch((e: any) => e.message)).toBe('aborted');
});

it('the per-attempt timeout also bounds reading the response body', async () => {
  vi.useFakeTimers();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{')); } });
  const fetch = vi.fn(async () => new Response(stream));
  let settled: unknown = null;
  const p = client(fetch, { timeout: 20, maxRetries: 0 }).emails.get('email-1').catch((e: unknown) => { settled = e; });
  await vi.advanceTimersByTimeAsync(21);
  await p;
  expect(settled).toBeInstanceOf(ConnectionError);
  expect((settled as Error).message).toMatch(/timed out after 20 ms/);
});

it('a broken response body is wrapped as a connection error, and a safe request is retried', async () => {
  const failure = new TypeError('connection reset while reading body');
  const broken = () => new Response(new ReadableStream({ start(c) { c.error(failure); } }));
  const once = vi.fn(async () => broken());
  const err = await client(once, { maxRetries: 0 }).emails.get('email-1').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as Error).cause).toBe(failure);
  vi.useFakeTimers();
  const answers = [broken(), new Response('{"id":"e1"}')];
  const retried = vi.fn(async () => answers.shift()!);
  const p = client(retried).emails.get('email-1');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await p).toEqual({ id: 'e1' });
  expect(retried).toHaveBeenCalledTimes(2);
});
