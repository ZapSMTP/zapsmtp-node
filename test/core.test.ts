import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError, ConflictError, ConnectionError, NotFoundError, Page, PermissionError, RateLimitError, ServerError,
  ValidationError, VERSION, WebhookVerificationError, ZapSMTP, ZapSMTPError, attachment, attachmentFromFile, verifyWebhook, verifyWebhookEvents,
} from '../src/index.js';
import { backoff, retryable, type RequestOptions } from '../src/core.js';

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a list of responses (or errors) and records each call. */
function fakeFetch(...answers: Array<Response | Error | (() => Response)>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a() : a.clone();
  });
  return { f: f as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_1', ...headers } });
const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json(status, { statusCode: status, name: code, message: `${code} happened`, error: { code, message: `${code} happened`, type: 'invalid_request_error' } }, headers);

function client(f: typeof fetch, opts: Record<string, unknown> = {}) {
  return new ZapSMTP('zap_test_key', { baseUrl: 'https://api.test/v1/', fetch: f, ...opts });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('client', () => {
  it('reads the key and base URL from the environment', async () => {
    vi.stubEnv('ZAP_API_KEY', 'zap_env');
    vi.stubEnv('ZAP_BASE_URL', 'https://env.test/v1');
    const { f, calls } = fakeFetch(json(200, { id: 'e1' }));
    const zap = new ZapSMTP({ fetch: f });
    expect(zap.apiKey).toBe('zap_env');
    await zap.emails.get('e1');
    expect(calls[0].url).toBe('https://env.test/v1/emails/e1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer zap_env');
  });

  it('defaults to the production API', () => {
    vi.stubEnv('ZAP_BASE_URL', '');
    delete process.env.ZAP_BASE_URL;
    expect(new ZapSMTP('k', { fetch: fakeFetch().f }).baseUrl).toBe('https://api.zapsmtp.com/v1');
  });

  it('needs a key', () => {
    vi.stubEnv('ZAP_API_KEY', '');
    delete process.env.ZAP_API_KEY;
    expect(() => new ZapSMTP()).toThrow(/Missing API key/);
  });

  it('needs fetch', () => {
    const saved = globalThis.fetch;
    // @ts-expect-error simulating an old runtime
    globalThis.fetch = undefined;
    try {
      expect(() => new ZapSMTP('k')).toThrow(/No fetch/);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('refuses an id that cannot be a path segment, without a request', async () => {
    const { f, calls } = fakeFetch(new Response(null, { status: 204 }));
    for (const id of ['..', '.', '']) {
      const err = await client(f).domains.delete(id).catch((e: any) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('invalid_parameter');
    }
    expect(await client(f).emails.receiving.attachments.get('m1', undefined as unknown as string).catch((e: any) => e.message)).toBe('aid must not be empty');
    expect(calls).toHaveLength(0);
    await client(f).domains.delete('a.b/..');
    expect(calls[0].url).toBe('https://api.test/v1/domains/a.b%2F..');
  });

  it('sends the headers every request carries', async () => {
    const { f, calls } = fakeFetch(json(200, { id: 'x' }));
    await client(f, { defaultHeaders: { 'X-Team': 'mail' } }).emails.get('a/b c', { headers: { 'X-Extra': '1' } });
    const h = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('https://api.test/v1/emails/a%2Fb%20c');
    expect(h['User-Agent']).toMatch(new RegExp(`^zapsmtp-node/${VERSION} \\(node/`));
    expect(h['X-Team']).toBe('mail');
    expect(h['X-Extra']).toBe('1');
    expect(h['Content-Type']).toBeUndefined();
  });

  it('names Bun and Deno in the User-Agent', async () => {
    const g = globalThis as any;
    for (const [k, v, want] of [['Bun', { version: '1.1' }, 'bun/1.1'], ['Deno', { version: { deno: '2.0' } }, 'deno/2.0']] as const) {
      g[k] = v;
      try {
        const { f, calls } = fakeFetch(json(200, {}));
        await client(f).usage.get();
        expect((calls[0].init.headers as Record<string, string>)['User-Agent']).toContain(`(${want})`);
      } finally {
        delete g[k];
      }
    }
    const versions = process.versions;
    Object.defineProperty(process, 'versions', { value: {}, configurable: true });
    try {
      const { f, calls } = fakeFetch(json(200, {}));
      await client(f).usage.get();
      expect((calls[0].init.headers as Record<string, string>)['User-Agent']).toContain('(unknown)');
    } finally {
      Object.defineProperty(process, 'versions', { value: versions, configurable: true });
    }
  });

  it('serializes query parameters: arrays repeat, objects become key[name]', async () => {
    const { f, calls } = fakeFetch(json(200, { object: 'list', data: [], has_more: false }));
    await client(f).emails.list({ limit: 5, q: undefined, metadata: { order_id: 'A-1', 'a b': 'c' } });
    expect(calls[0].url).toBe('https://api.test/v1/emails?limit=5&metadata%5Border_id%5D=A-1&metadata%5Ba+b%5D=c');
    const page = fakeFetch(json(200, { object: 'list', data: [], has_more: false }));
    await client(page.f).request({ method: 'GET', path: '/x', query: { tag: ['a', 'b'], none: null } });
    expect(page.calls[0].url).toBe('https://api.test/v1/x?tag=a&tag=b');
  });

  it('sends JSON bodies and an Idempotency-Key on sends', async () => {
    const { f, calls } = fakeFetch(json(200, { id: 'e1' }));
    const zap = client(f);
    expect(await zap.emails.send({ from: 'a@x.test', to: 'b@y.test', subject: 'Hi', text: 'Hello' })).toEqual({ id: 'e1' });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/json');
    expect(h['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ from: 'a@x.test', to: 'b@y.test', subject: 'Hi', text: 'Hello' });
    await zap.emails.send({ from: 'a', to: 'b', subject: 's' }, { idempotencyKey: 'order-1' });
    expect((calls[1].init.headers as Record<string, string>)['Idempotency-Key']).toBe('order-1');
  });

  it('refuses an empty Idempotency-Key before sending, and the caller header wins whatever its case', async () => {
    const { f, calls } = fakeFetch(json(200, { id: 'e1' }));
    const zap = client(f);
    const params = { from: 'a', to: 'b', subject: 's' };
    for (const opts of <RequestOptions[]>[{ idempotencyKey: '' }, { idempotencyKey: '  ' }, { headers: { 'idempotency-key': '' } }, { headers: { 'Idempotency-Key': ' ' } }]) {
      const err = await zap.emails.send(params, opts).catch((e: any) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('invalid_parameter');
    }
    expect(calls).toHaveLength(0);
    await zap.emails.send(params, { headers: { 'idempotency-key': 'mine' } });
    const h = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'idempotency-key')).toEqual(['idempotency-key']);
    expect(h['idempotency-key']).toBe('mine');
  });

  it('sends a batch with its validation mode', async () => {
    const { f, calls } = fakeFetch(json(200, { data: [] }));
    await client(f).emails.sendBatch([{ from: 'a', to: 'b', subject: 's' }]);
    expect((calls[0].init.headers as Record<string, string>)['x-batch-validation']).toBeUndefined();
    await client(f).emails.sendBatch([{ from: 'a', to: 'b', subject: 's' }], { validation: 'permissive' });
    expect((calls[1].init.headers as Record<string, string>)['x-batch-validation']).toBe('permissive');
  });

  it('answers void for 204', async () => {
    const { f } = fakeFetch(new Response(null, { status: 204 }));
    expect(await client(f).domains.delete('d1')).toBeUndefined();
  });

  it('keeps a body that is not JSON as text', async () => {
    const { f } = fakeFetch(new Response('plain', { status: 200 }));
    expect(await client(f).usage.get()).toBe('plain');
  });

  it('gives the status, headers and request id with withResponse', async () => {
    const { f } = fakeFetch(json(200, { id: 'e1' }, { 'RateLimit-Remaining': '9' }));
    const p = client(f).emails.get('e1');
    const { data, response } = await p.withResponse();
    expect(data).toEqual({ id: 'e1' });
    expect(response.status).toBe(200);
    expect(response.requestId).toBe('req_1');
    expect(response.headers.get('ratelimit-remaining')).toBe('9');
    expect(await p.catch(() => 'no')).toEqual({ id: 'e1' });
    let done = false;
    await p.finally(() => { done = true; });
    expect(done).toBe(true);
  });

  it('uploads an image file as multipart', async () => {
    const { f, calls } = fakeFetch(json(201, { id: 'img' }));
    const zap = client(f);
    await zap.templateAssets.uploadFile(new Uint8Array([1, 2, 3]), { name: 'logo.png' });
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('file') as File).name).toBe('logo.png');
    expect(form.get('name')).toBe('logo.png');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    await zap.templateAssets.uploadFile(new Blob(['x']), { filename: 'a.gif' });
    expect(((calls[1].init.body as FormData).get('file') as File).name).toBe('a.gif');
    expect((calls[1].init.body as FormData).get('name')).toBeNull();
    await zap.templateAssets.uploadFile(new ArrayBuffer(2));
    expect(((calls[2].init.body as FormData).get('file') as File).name).toBe('image');
  });
});

describe('errors', () => {
  const table: Array<[number, string, new (...a: any[]) => ZapSMTPError]> = [
    [400, 'validation_error', ValidationError], [401, 'invalid_api_key', AuthenticationError],
    [403, 'restricted_api_key', PermissionError], [404, 'not_found', NotFoundError], [409, 'conflict', ConflictError],
    [413, 'payload_too_large', ValidationError], [422, 'invalid_parameter', ValidationError],
    [429, 'monthly_quota_exceeded', RateLimitError], [500, 'internal_error', ServerError], [410, 'link_expired', ZapSMTPError],
  ];
  for (const [status, code, Cls] of table) {
    it(`maps ${status} ${code}`, async () => {
      const { f } = fakeFetch(apiError(status, code));
      const err = await client(f, { maxRetries: 0 }).emails.get('x').catch((e: any) => e);
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(ZapSMTPError);
      expect(err).toMatchObject({ status, code, message: `${code} happened`, type: 'invalid_request_error', requestId: 'req_1' });
      expect(err.name).toBe(Cls.name);
    });
  }

  it('reads the flat error shape and a body that is not JSON', async () => {
    const flat = fakeFetch(json(422, { statusCode: 422, name: 'missing_required_field', message: 'subject is required' }));
    expect(await client(flat.f).emails.get('x').catch((e: any) => e)).toMatchObject({ code: 'missing_required_field', message: 'subject is required', type: '' });
    const text = fakeFetch(new Response('bad gateway', { status: 418 }));
    expect(await client(text.f).emails.get('x').catch((e: any) => e)).toMatchObject({ status: 418, code: '', message: 'HTTP 418', requestId: null });
  });

  it('gives Retry-After on rate limits', async () => {
    const { f } = fakeFetch(apiError(429, 'monthly_quota_exceeded', { 'Retry-After': '7' }));
    const err = (await client(f).emails.get('x').catch((e: any) => e)) as RateLimitError;
    expect(err.retryAfter).toBe(7);
    expect(new RateLimitError('x').retryAfter).toBeNull();
  });

  it('wraps network failures', async () => {
    const { f } = fakeFetch(new TypeError('fetch failed'));
    const err = await client(f, { maxRetries: 0 }).emails.get('x').catch((e: any) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.status).toBe(0);
    expect(err.cause).toBeInstanceOf(TypeError);
    const odd = fakeFetch(Object.assign(new Error(), { message: undefined }) as Error);
    const thrown = { toString: () => 'weird' };
    const g = vi.fn(async () => { throw thrown; }) as unknown as typeof fetch;
    expect((await client(g, { maxRetries: 0 }).emails.get('x').catch((e: any) => e)).message).toBe('weird');
    expect(await client(odd.f, { maxRetries: 0 }).emails.get('x').catch((e: any) => e)).toBeInstanceOf(ConnectionError);
  });

  it('times out', async () => {
    const f = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const err = await client(f, { maxRetries: 0, timeout: 20 }).emails.get('x').catch((e: any) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toMatch(/timed out after 20 ms/);
  });

  it('stops on the caller\'s abort without retrying', async () => {
    const ctrl = new AbortController();
    const f = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      ctrl.abort();
    })) as unknown as typeof fetch;
    await expect(client(f).emails.get('x', { signal: ctrl.signal })).rejects.toThrow('aborted');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  it('retries safe requests on 5xx and network errors, honouring Retry-After', async () => {
    vi.useFakeTimers();
    const { f, calls } = fakeFetch(apiError(503, 'service_unavailable', { 'Retry-After': '2' }), new TypeError('reset'), json(200, { id: 'e1' }));
    const p = client(f).emails.get('e1');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ id: 'e1' });
    expect(calls).toHaveLength(3);
  });

  it('retries a send with the same Idempotency-Key', async () => {
    vi.useFakeTimers();
    const { f, calls } = fakeFetch(apiError(502, 'bad_gateway'), json(200, { id: 'e1' }));
    const p = client(f).emails.send({ from: 'a', to: 'b', subject: 's' });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
  });

  it('does not retry a create on 5xx or a lost connection, but does on 429', async () => {
    vi.useFakeTimers();
    const five = fakeFetch(apiError(500, 'internal_error'));
    await expect(client(five.f).domains.create({ name: 'a.test' })).rejects.toBeInstanceOf(ServerError);
    expect(five.calls).toHaveLength(1);
    const lost = fakeFetch(new TypeError('reset'));
    await expect(client(lost.f).domains.create({ name: 'a.test' })).rejects.toBeInstanceOf(ConnectionError);
    expect(lost.calls).toHaveLength(1);
    const limited = fakeFetch(apiError(429, 'rate_limit_exceeded', { 'Retry-After': '1' }), json(201, { id: 'd1' }));
    const p = client(limited.f).domains.create({ name: 'a.test' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ id: 'd1' });
  });

  it('gives up after maxRetries', async () => {
    vi.useFakeTimers();
    const { f, calls } = fakeFetch(apiError(503, 'service_unavailable', { 'Retry-After': '0' }));
    const p = client(f, { maxRetries: 3 }).emails.get('x').catch((e: any) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(4);
    const once = fakeFetch(apiError(503, 'service_unavailable'));
    expect(await client(once.f).emails.get('x', { maxRetries: 0 }).catch((e: any) => e)).toBeInstanceOf(ServerError);
    expect(once.calls).toHaveLength(1);
  });

  it('decides what is worth retrying', () => {
    expect(retryable(429, 'overloaded', false)).toBe(true);
    expect(retryable(429, 'daily_quota_exceeded', true)).toBe(false);
    expect(retryable(409, 'idempotency_request_in_progress', true)).toBe(true);
    expect(retryable(409, 'idempotency_key_reused', true)).toBe(false);
    expect(retryable(503, 'service_unavailable', true)).toBe(true);
    expect(retryable(503, 'service_unavailable', false)).toBe(false);
    expect(retryable(422, 'invalid_parameter', true)).toBe(false);
  });

  it('backs off exponentially with jitter, capped, or as Retry-After says', () => {
    for (let a = 0; a < 8; a++) {
      const cap = Math.min(500 * 2 ** a, 8000);
      const d = backoff(a, null);
      expect(d).toBeGreaterThanOrEqual(cap / 2);
      expect(d).toBeLessThanOrEqual(cap);
    }
    expect(backoff(0, 3)).toBe(3000);
    expect(backoff(0, 600)).toBe(60_000);
  });

  it('reads Retry-After as an HTTP date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { f, calls } = fakeFetch(apiError(503, 's', { 'Retry-After': 'Thu, 01 Jan 2026 00:00:03 GMT' }), json(200, {}));
    const p = client(f).emails.get('x');
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(calls).toHaveLength(2);
    const bad = fakeFetch(apiError(429, 'overloaded', { 'Retry-After': 'soon' }));
    expect((await client(bad.f, { maxRetries: 0 }).emails.get('x').catch((e: any) => e)).retryAfter).toBeNull();
    const past = fakeFetch(apiError(429, 'overloaded', { 'Retry-After': 'Thu, 01 Jan 2025 00:00:00 GMT' }));
    expect((await client(past.f, { maxRetries: 0 }).emails.get('x').catch((e: any) => e)).retryAfter).toBe(0);
  });
});

describe('paging', () => {
  const page = (ids: string[], more: boolean, extra: object = {}) => json(200, { object: 'list', has_more: more, data: ids.map((id) => ({ id })), ...extra });

  it('walks every page with before = the last id, keeping the filters', async () => {
    const { f, calls } = fakeFetch(page(['a', 'b'], true), page(['c'], false));
    const ids: string[] = [];
    for await (const e of client(f).emails.list({ limit: 2, after: '2026-01-01T00:00:00Z' })) ids.push(e.id!);
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(calls[1].url).toBe('https://api.test/v1/emails?limit=2&after=2026-01-01T00%3A00%3A00Z&before=b');
  });

  it('walks suppressions with next_cursor', async () => {
    const { f, calls } = fakeFetch(page(['a'], true, { next_cursor: 'cur1' }), page(['b'], true, { next_cursor: null }));
    const ids: string[] = [];
    for await (const s of client(f).suppressions.list()) ids.push((s as any).id);
    expect(ids).toEqual(['a', 'b']);
    expect(calls[1].url).toBe('https://api.test/v1/suppressions?after=cur1');
    expect(calls).toHaveLength(2);
  });

  it('gives one page when awaited', async () => {
    const { f } = fakeFetch(page(['a'], true));
    const first = await client(f).emails.list();
    expect(first).toBeInstanceOf(Page);
    expect(first.data).toEqual([{ id: 'a' }]);
    expect(first.hasNextPage()).toBe(true);
    expect(first.object).toBe('list');
  });

  it('stops where no next page can be asked for', async () => {
    const noId = fakeFetch(json(200, { object: 'list', has_more: true, data: [{}] }));
    const p = await client(noId.f).emails.list();
    expect(p.hasNextPage()).toBe(false);
    expect(await p.getNextPage()).toBeNull();
    const unpaged = fakeFetch(page(['a'], true));
    const d = await client(unpaged.f).domains.list();
    expect(await d.getNextPage()).toBeNull();
    const last = fakeFetch(page(['a'], false));
    expect(await (await client(last.f).emails.list()).getNextPage()).toBeNull();
    const empty = fakeFetch(json(200, { object: 'list' }));
    const e = await client(empty.f).emails.list();
    expect(e.data).toEqual([]);
    expect(e.has_more).toBe(false);
  });
});

describe('webhooks', () => {
  const { vectors } = JSON.parse(readFileSync(new URL('../../spec/webhook-vectors.json', import.meta.url), 'utf8'));
  for (const v of vectors) {
    it(`vector: ${v.name}`, () => {
      const opts = { now: v.now, tolerance: v.tolerance };
      const one = () => verifyWebhook(v.payload, { 'Zap-Signature': v.header }, v.secret, opts);
      const all = () => verifyWebhookEvents(v.payload, { 'Zap-Signature': v.header }, v.secret, opts);
      if (!v.valid) {
        expect(one).toThrow(WebhookVerificationError);
        expect(all).toThrow(WebhookVerificationError);
      } else if (v.batch) {
        expect(one).toThrow(/batch of events: use verifyWebhookEvents/);
        expect(all()).toEqual(JSON.parse(v.payload));
      } else {
        expect(one()).toEqual(JSON.parse(v.payload));
        expect(all()).toEqual([JSON.parse(v.payload)]);
      }
    });
  }

  it('refuses a signed body that is not an event', async () => {
    const { createHmac } = await import('node:crypto');
    const t = 1700000000;
    for (const body of ['42', 'null', '[1]', '[[]]']) {
      const header = `t=${t},v1=${createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex')}`;
      expect(() => verifyWebhookEvents(body, header, 'whsec_x', { now: t })).toThrow(/not an event/);
      if (!body.startsWith('[')) expect(() => verifyWebhook(body, header, 'whsec_x', { now: t })).toThrow(/not an event/);
    }
    const header = `t=${t},v1=${createHmac('sha256', 'whsec_x').update(`${t}.{}`).digest('hex')}`;
    expect(client(fakeFetch().f).webhooks.verifyEvents('{}', header, 'whsec_x', { now: t })).toEqual([{}]);
  });

  it('takes Headers, a header value, bytes, and the client method', () => {
    const v = vectors[0];
    const headers = new Headers({ 'zap-signature': v.header });
    const bytes = new TextEncoder().encode(v.payload);
    expect(verifyWebhook(bytes, headers, v.secret, { now: v.now })).toEqual(JSON.parse(v.payload));
    expect(verifyWebhook(v.payload, v.header, v.secret, { now: v.now }).type).toBe('email.delivered');
    expect(verifyWebhook(v.payload, { 'zap-signature': [v.header] }, v.secret, { now: v.now }).id).toBe('evt_1');
    const zap = client(fakeFetch().f);
    expect(zap.webhooks.verify(v.payload, headers, v.secret, { now: v.now }).id).toBe('evt_1');
  });

  it('checks against the clock by default', () => {
    const v = vectors[0];
    vi.useFakeTimers();
    vi.setSystemTime(v.now * 1000 + 10_000);
    expect(verifyWebhook(v.payload, v.header, v.secret).id).toBe('evt_1');
    vi.setSystemTime(v.now * 1000 + 301_000);
    expect(() => verifyWebhook(v.payload, v.header, v.secret)).toThrow(/too old/);
  });

  it('refuses a missing header or secret and a body that is not JSON', async () => {
    expect(() => verifyWebhook('{}', {}, 's')).toThrow(/Missing Zap-Signature/);
    expect(() => verifyWebhook('{}', new Headers(), 's')).toThrow(/Missing Zap-Signature/);
    expect(() => verifyWebhook('{}', 't=1,v1=00', '')).toThrow(/Missing webhook secret/);
    const { createHmac } = await import('node:crypto');
    const t = 1700000000;
    const sig = createHmac('sha256', 'whsec_x').update(`${t}.not json`).digest('hex');
    expect(() => verifyWebhook('not json', `t=${t},v1=${sig}`, 'whsec_x', { now: t })).toThrow(/not JSON/);
  });
});

describe('attachments', () => {
  it('encodes bytes and text and guesses the content type', () => {
    expect(attachment('a.pdf', new Uint8Array([1, 2]))).toEqual({ filename: 'a.pdf', content: 'AQI=', content_type: 'application/pdf' });
    expect(attachment('notes', 'hi', { contentType: 'text/plain', contentId: 'n1' })).toEqual({ filename: 'notes', content: 'aGk=', content_type: 'text/plain', content_id: 'n1' });
    expect(attachment('x.unknown', new ArrayBuffer(1)).content_type).toBeUndefined();
  });

  it('reads a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zap-'));
    writeFileSync(join(dir, 'Report.PNG'), Buffer.from([137, 80]));
    expect(await attachmentFromFile(join(dir, 'Report.PNG'))).toEqual({ filename: 'Report.PNG', content: 'iVA=', content_type: 'image/png' });
    expect((await attachmentFromFile(join(dir, 'Report.PNG'), { filename: 'r.png' })).filename).toBe('r.png');
  });
});
