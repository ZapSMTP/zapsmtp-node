// Webhook signature verification (docs: Webhook events). Every request
// ZapSMTP sends carries Zap-Signature: t=<unix seconds>,v1=<hex>, where v1 is
// HMAC-SHA256 over "<t>.<raw body>" keyed with the whole secret (its whsec_
// prefix included). Two v1 entries are sent for 24 hours after a rotation.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ZapSMTPError } from './core.js';

export class WebhookVerificationError extends ZapSMTPError {}

/** A webhook request body. */
export interface WebhookEvent<D = Record<string, any>> {
  /** evt_…; absent on email.received, thread.created and thread.replied (see Zap-Event-Id) */
  id?: string;
  type: string;
  created_at: string;
  data: D;
}

export interface VerifyOptions {
  /** Oldest signature accepted, in seconds (default 300). */
  tolerance?: number;
  /** The time to check against, in unix seconds (default now). */
  now?: number;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(',') : v;
  return undefined;
}

/** Checks the signature and returns the parsed body (an event, or an array of them for a batch). */
function verified(payload: string | Uint8Array, headers: HeaderBag | string, secret: string, options: VerifyOptions): unknown {
  const sig = typeof headers === 'string' ? headers : header(headers, 'zap-signature');
  if (!sig) throw new WebhookVerificationError('Missing Zap-Signature header');
  if (!secret) throw new WebhookVerificationError('Missing webhook secret');
  let t = '';
  const v1: string[] = [];
  for (const part of sig.split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  // unix seconds: at most 12 digits, so the arithmetic below stays exact
  if (!/^\d{1,12}$/.test(t) || v1.length === 0) throw new WebhookVerificationError('Malformed Zap-Signature header');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.tolerance ?? 300;
  if (Math.abs(now - Number(t)) > tolerance) throw new WebhookVerificationError('Webhook signature is too old (or from the future)');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const want = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
  const ok = v1.some((hex) => /^[0-9a-f]{64}$/i.test(hex) && timingSafeEqual(Buffer.from(hex, 'hex'), want));
  if (!ok) throw new WebhookVerificationError('Webhook signature does not match');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (cause) {
    throw new WebhookVerificationError('Webhook body is not JSON', { cause });
  }
}

/**
 * Checks a webhook request's signature and returns its event. Pass the body
 * exactly as received (a string or bytes), before any JSON parsing. A webhook
 * with batch delivery sends an array of events: use verifyWebhookEvents.
 */
export function verifyWebhook<D = Record<string, any>>(payload: string | Uint8Array, headers: HeaderBag | string, secret: string, options: VerifyOptions = {}): WebhookEvent<D> {
  const body = verified(payload, headers, secret, options);
  if (Array.isArray(body)) throw new WebhookVerificationError('The body is a batch of events: use verifyWebhookEvents');
  if (!body || typeof body !== 'object') throw new WebhookVerificationError('Webhook body is not an event');
  return body as WebhookEvent<D>;
}

/**
 * Checks a webhook request's signature and returns its events: every event of
 * a batch (a webhook with batch: true), or the one event of any other request.
 */
export function verifyWebhookEvents<D = Record<string, any>>(payload: string | Uint8Array, headers: HeaderBag | string, secret: string, options: VerifyOptions = {}): WebhookEvent<D>[] {
  const body = verified(payload, headers, secret, options);
  const events = Array.isArray(body) ? body : [body];
  if (events.some((e) => !e || typeof e !== 'object' || Array.isArray(e))) throw new WebhookVerificationError('Webhook body is not an event');
  return events as WebhookEvent<D>[];
}
