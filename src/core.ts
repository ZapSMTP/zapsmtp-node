// The hand-written core of the SDK: HTTP, retries, errors, paging. The API
// resources and types are generated (src/generated) from the API reference.
import { randomUUID } from 'node:crypto';
import { VERSION } from './version.js';

export interface ClientOptions {
  /** Defaults to the ZAP_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to ZAP_BASE_URL, else https://api.zapsmtp.com/v1. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds (default 60,000). */
  timeout?: number;
  /** Retries of a failed request that is safe to retry (default 2). */
  maxRetries?: number;
  /** Headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** A fetch implementation (default: the global fetch). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Sent as Idempotency-Key where the API takes one; otherwise the SDK makes one. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

/** What the API answered besides the body. */
export interface ResponseInfo {
  status: number;
  headers: Headers;
  /** X-Request-Id: quote it to support. */
  requestId: string | null;
}

// ---- errors ----------------------------------------------------------------

/** An error answer of the API, or no answer at all (ConnectionError). */
export class ZapSMTPError extends Error {
  /** HTTP status; 0 when there was no answer. */
  readonly status: number;
  /** The API's error code, e.g. "invalid_parameter". */
  readonly code: string;
  /** The error type, e.g. "invalid_request_error". */
  readonly type: string;
  readonly requestId: string | null;
  readonly headers: Headers | null;
  /** The parsed error body. */
  readonly body: unknown;

  constructor(message: string, init: { status?: number; code?: string; type?: string; requestId?: string | null; headers?: Headers | null; body?: unknown; cause?: unknown } = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status ?? 0;
    this.code = init.code ?? '';
    this.type = init.type ?? '';
    this.requestId = init.requestId ?? null;
    this.headers = init.headers ?? null;
    this.body = init.body;
  }
}
export class AuthenticationError extends ZapSMTPError {}
export class PermissionError extends ZapSMTPError {}
export class NotFoundError extends ZapSMTPError {}
export class ConflictError extends ZapSMTPError {}
export class ValidationError extends ZapSMTPError {}
export class RateLimitError extends ZapSMTPError {
  /** Seconds the API asked to wait (Retry-After), when it said. */
  get retryAfter(): number | null {
    return retryAfterSeconds(this.headers);
  }
}
export class ServerError extends ZapSMTPError {}
/** No answer: network failure or timeout. */
export class ConnectionError extends ZapSMTPError {}

function errorFor(status: number, body: any, headers: Headers): ZapSMTPError {
  const code: string = body?.error?.code ?? body?.name ?? '';
  const message: string = body?.error?.message ?? body?.message ?? `HTTP ${status}`;
  const init = { status, code, type: body?.error?.type ?? '', requestId: headers.get('x-request-id'), headers, body };
  const Cls =
    status === 401 ? AuthenticationError :
    status === 403 ? PermissionError :
    status === 404 ? NotFoundError :
    status === 409 ? ConflictError :
    status === 400 || status === 413 || status === 422 ? ValidationError :
    status === 429 ? RateLimitError :
    status >= 500 ? ServerError : ZapSMTPError;
  return new Cls(message, init);
}

// ---- promises --------------------------------------------------------------

/** A request in flight: await it for the body, or call withResponse() for the status and headers too. */
export class APIPromise<T> implements PromiseLike<T> {
  constructor(protected readonly result: Promise<{ data: T; response: ResponseInfo }>) {
    result.catch(() => {}); // handled by whoever awaits it
  }
  withResponse(): Promise<{ data: T; response: ResponseInfo }> {
    return this.result;
  }
  then<A = T, B = never>(ok?: ((v: T) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.result.then((r) => r.data).then(ok, fail);
  }
  catch<B = never>(fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.then(undefined, fail);
  }
  finally(f?: (() => void) | null): Promise<T> {
    return this.then().finally(f);
  }
}

/** One page of a list. */
export interface PageData<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor?: string | null;
  [key: string]: unknown;
}

export class Page<T> implements PageData<T> {
  object = 'list' as const;
  data: T[];
  has_more: boolean;
  next_cursor?: string | null;
  [key: string]: unknown;
  readonly #next: Request | null;
  readonly #load: (r: Request) => PagePromise<T>;

  constructor(body: PageData<T>, request: Request, paging: Paging, load: (r: Request) => PagePromise<T>) {
    Object.assign(this, body);
    this.data = body.data ?? [];
    this.has_more = !!body.has_more;
    this.#next = this.has_more ? nextPage(request, this, paging) : null;
    this.#load = load;
  }
  /** Whether there is a next page to ask for (no request is made). */
  hasNextPage(): boolean {
    return this.#next !== null;
  }
  /** The next page, or null after the last one. */
  async getNextPage(): Promise<Page<T> | null> {
    return this.#next ? await this.#load(this.#next) : null;
  }
}

/** A list request: await it for the first page, or iterate it (for await) for every item of every page. */
export class PagePromise<T> extends APIPromise<Page<T>> implements AsyncIterable<T> {
  constructor(result: Promise<{ data: Page<T>; response: ResponseInfo }>, private readonly signal?: AbortSignal) {
    super(result);
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: Page<T> | null = await this;
    while (page) {
      // the caller's abort also stops the items of a page already loaded
      for (const item of page.data) {
        if (this.signal?.aborted) throw abortReason(this.signal);
        yield item;
      }
      page = await page.getNextPage();
    }
  }
}

// ---- client ----------------------------------------------------------------

export interface Request {
  method: string;
  /** with {name} placeholders filled from pathParams */
  path: string;
  pathParams?: Record<string, string | number>;
  query?: object;
  body?: unknown;
  /** multipart/form-data instead of JSON */
  form?: FormData;
  headers?: Record<string, string | undefined>;
  /** the operation takes Idempotency-Key, so the SDK always sends one and may retry */
  idempotent?: boolean;
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NO_RETRY_429 = new Set(['monthly_quota_exceeded', 'daily_quota_exceeded', 'thread_reply_limit']);

export class BaseClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKeyOrOptions?: string | ClientOptions, options: ClientOptions = {}) {
    const o = typeof apiKeyOrOptions === 'string' ? { ...options, apiKey: apiKeyOrOptions } : { ...apiKeyOrOptions, ...options };
    const env = process.env;
    const key = o.apiKey ?? env.ZAP_API_KEY;
    if (!key) throw new ZapSMTPError('Missing API key: pass it to new ZapSMTP(...) or set ZAP_API_KEY');
    this.apiKey = key;
    this.baseUrl = (o.baseUrl ?? env.ZAP_BASE_URL ?? 'https://api.zapsmtp.com/v1').replace(/\/+$/, '');
    this.timeout = o.timeout ?? 60_000;
    this.maxRetries = o.maxRetries ?? 2;
    this.defaultHeaders = o.defaultHeaders ?? {};
    const f = o.fetch ?? globalThis.fetch;
    if (!f) throw new ZapSMTPError('No fetch available: use Node 18 or newer, or pass options.fetch');
    this.fetchImpl = f.bind(globalThis);
  }

  /** @internal */
  request<T>(req: Request, options: RequestOptions = {}): APIPromise<T> {
    return new APIPromise(this.send<T>(req, options));
  }

  /** @internal */
  requestPage<T>(req: Request, options: RequestOptions, paging: Paging): PagePromise<T> {
    const load = (r: Request): PagePromise<T> =>
      new PagePromise(this.send<PageData<T>>(r, options).then(({ data, response }) => ({
        data: new Page<T>(data, r, paging, load),
        response,
      })), options.signal);
    return load(req);
  }

  private url(req: Request): string {
    const path = req.path.replace(/\{(\w+)\}/g, (_, name: string) => seg(name, req.pathParams?.[name]));
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
      else if (typeof v === 'object') for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) u.searchParams.append(`${k}[${mk}]`, String(mv));
      else u.searchParams.append(k, String(v));
    }
    return u.toString();
  }

  private async send<T>(req: Request, options: RequestOptions): Promise<{ data: T; response: ResponseInfo }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `zapsmtp-node/${VERSION} (${runtime()})`,
    };
    // the caller's default headers replace ours whatever their case
    for (const [k, v] of Object.entries(this.defaultHeaders)) setHeader(headers, k, v);
    for (const [k, v] of Object.entries(req.headers ?? {})) if (v !== undefined) headers[k] = v;
    if (req.idempotent) headers['Idempotency-Key'] = options.idempotencyKey ?? randomUUID();
    // and so do the headers of this request
    for (const [k, v] of Object.entries(options.headers ?? {})) setHeader(headers, k, v);
    // an empty key turns deduplication off on the server, so a retried send
    // could go out twice: refused before anything is sent
    const key = Object.entries(headers).find(([h]) => h.toLowerCase() === 'idempotency-key');
    if (key && !key[1].trim()) throw new ValidationError('idempotencyKey must not be empty', { code: 'invalid_parameter' });
    let body: BodyInit | undefined;
    if (req.form) body = req.form;
    else if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const url = this.url(req); // throws on an id that cannot be a path segment
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const safe = req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE' || !!req.idempotent;

    let attempt = -1;
    while (true) {
      attempt++;
      let res: { status: number; ok: boolean; headers: Headers; text: string };
      try {
        res = await this.attempt(url, { method: req.method, headers, body }, options);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        // a timeout or a broken connection (sending, or reading the answer):
        // the request may have reached the server, so only a request that is
        // safe to repeat is sent again
        if (attempt < maxRetries && safe) {
          await sleep(backoff(attempt, null), options.signal);
          continue;
        }
        throw new ConnectionError(err instanceof Error ? err.message : String(err), { cause: err });
      }
      const info: ResponseInfo = { status: res.status, headers: res.headers, requestId: res.headers.get('x-request-id') };
      let parsed: any = undefined;
      if (res.text) {
        try { parsed = JSON.parse(res.text); } catch { parsed = res.text; }
      }
      if (res.ok) return { data: parsed as T, response: info };
      const err = errorFor(res.status, parsed, res.headers);
      if (attempt < maxRetries && retryable(res.status, err.code, safe)) {
        await sleep(backoff(attempt, retryAfterSeconds(res.headers)), options.signal);
        continue;
      }
      throw err;
    }
  }

  // One attempt, the body read included: the timeout and the caller's abort
  // cover a server that sends its headers and then stalls.
  private async attempt(url: string, init: RequestInit, options: RequestOptions) {
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);
    const ctrl = new AbortController();
    const timeout = options.timeout ?? this.timeout;
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeout} ms`)), timeout);
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: ctrl.signal });
      const text = await new Promise<string>((resolve, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason));
        res.text().then(resolve, reject);
      });
      return { status: res.status, ok: res.ok, headers: res.headers, text };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ---- helpers ---------------------------------------------------------------

/** Whether an error answer is worth another attempt. */
export function retryable(status: number, code: string, safe: boolean): boolean {
  if (status === 429) return !NO_RETRY_429.has(code); // refused before any work: always safe
  if (status === 409) return code === 'idempotency_request_in_progress';
  return safe && RETRY_STATUSES.has(status);
}

/** Milliseconds to wait before attempt number attempt+1. */
export function backoff(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter, 60) * 1000;
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base / 2 + Math.random() * (base / 2);
}

function retryAfterSeconds(headers: Headers | null): number | null {
  const v = headers?.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, (at - Date.now()) / 1000);
}

/** How a list asks for its next page (sdks/spec/names.json paging). */
export type Paging = 'before' | 'after' | 'logs' | 'thread' | 'cursor' | null;

/**
 * The request of the page after this one, or null after the last page
 * (exported for stateless cursors: MCP, CLI). req is the request of this page;
 * its other query parameters are kept.
 */
export function nextPage<T>(req: Request, page: PageData<T>, paging: Paging): Request | null {
  if (!page.has_more) return null;
  const q = (req.query ?? {}) as Record<string, unknown>;
  const first = page.data[0] as { id?: string } | undefined;
  const last = page.data.at(-1) as { id?: string; last_message_at?: string } | undefined;
  const next = (extra: Record<string, unknown>): Request => ({ ...req, query: { ...q, ...extra } });
  switch (paging) {
    case 'cursor': return page.next_cursor ? next({ after: page.next_cursor }) : null;
    case 'before': return last?.id ? next({ before: last.id }) : null;
    case 'after': return last?.id ? next({ after: last.id }) : null;
    // with after, logs come oldest-first from the server and newest-first in
    // the page: the next newer page starts after the page's newest entry
    case 'logs': return q.after !== undefined ? (first?.id ? next({ after: first.id }) : null) : (last?.id ? next({ before: last.id }) : null);
    case 'thread': return last?.id && last.last_message_at ? next({ before: last.last_message_at, before_id: last.id }) : null;
    default: return null;
  }
}

/** A wait between attempts: the caller's abort ends it at once, with the caller's reason. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new Error('aborted');

/** Sets a header, replacing any spelling of its name. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const h of Object.keys(headers)) if (h.toLowerCase() === name.toLowerCase()) delete headers[h];
  headers[name] = value;
}

function runtime(): string {
  const g = globalThis as any;
  if (g.Bun) return `bun/${g.Bun.version}`;
  if (g.Deno) return `deno/${g.Deno.version?.deno}`;
  if (typeof process !== 'undefined' && process.versions?.node) return `node/${process.versions.node}`;
  return 'unknown';
}

/**
 * One path segment, escaped. An empty value, "." or ".." can be no id: URL
 * parsing would resolve them into another path, so they are refused before
 * anything is sent.
 */
function seg(name: string, v: string | number | undefined): string {
  const s = v === undefined ? '' : String(v);
  if (s === '' || s === '.' || s === '..') throw new ValidationError(`${name} must not be ${s === '' ? 'empty' : `"${s}"`}`, { code: 'invalid_parameter' });
  return encodeURIComponent(s);
}
