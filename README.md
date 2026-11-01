# ZapSMTP Node.js SDK

The official Node.js and TypeScript library for the [ZapSMTP](https://zapsmtp.com) email API: send,
receive and track email, manage templates, domains, webhooks and everything else the API does.

- Every API operation, with types for every parameter and response
- Safe automatic retries: sends carry an `Idempotency-Key`, so a retry never sends twice
- `for await` over every page of any list
- Webhook signature verification
- Node.js 18+, Bun and Deno; ESM and CommonJS; no dependencies

## Install

```bash
npm install zapsmtp
```

## Send an email

```ts
import { ZapSMTP } from 'zapsmtp';

const zap = new ZapSMTP('zap_...'); // or set ZAP_API_KEY and call new ZapSMTP()

const { id } = await zap.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'jane@example.org',
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
  tags: [{ name: 'category', value: 'receipt' }],
  metadata: { order_id: 'A-1042' },
});
```

With a template:

```ts
await zap.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'jane@example.org',
  template: { id: 'receipt', variables: { name: 'Jane', total: 42 } },
});
```

Attachments:

```ts
import { attachmentFromFile } from 'zapsmtp';

await zap.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'jane@example.org',
  subject: 'Your invoice',
  text: 'Attached.',
  attachments: [await attachmentFromFile('./invoice.pdf')],
});
```

Up to 100 emails at once:

```ts
const { data, errors } = await zap.emails.sendBatch(emails, { validation: 'permissive' });
```

## Lists

Awaiting a list gives one page; iterating it walks every page.

```ts
const page = await zap.emails.list({ limit: 50, status: 'bounced' });

for await (const email of zap.emails.list({ status: 'bounced' })) {
  console.log(email.id, email.to);
}
```

## Errors

Every API error throws a `ZapSMTPError` subclass with `status`, `code`, `message` and `requestId`.

```ts
import { RateLimitError, ValidationError, ZapSMTPError } from 'zapsmtp';

try {
  await zap.emails.send(email);
} catch (err) {
  if (err instanceof ValidationError) console.error(err.code, err.message); // e.g. invalid_parameter
  else if (err instanceof RateLimitError) console.error('retry in', err.retryAfter, 's');
  else throw err;
}
```

| Class | When |
|---|---|
| `AuthenticationError` | 401: missing or invalid key |
| `PermissionError` | 403: the key may not do this, or the domain is not verified |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `ValidationError` | 400, 413, 422: the request is wrong |
| `RateLimitError` | 429: `retryAfter` says how long to wait |
| `ServerError` | 5xx |
| `ConnectionError` | no answer: network failure or timeout |

## Retries and timeouts

A request that failed on the way (408, 429, 500, 502, 503, 504, a lost connection) is tried again twice by default,
waiting as the API's `Retry-After` says or backing off exponentially. Only requests that are safe to
repeat are retried: reads, updates by `PUT`, deletes, and sends, which always carry an
`Idempotency-Key` (pass your own with `{ idempotencyKey }` to make retries of your own safe too). Other `POST` and `PATCH` requests are retried only on 429. A 429 for a quota
(`monthly_quota_exceeded`, `daily_quota_exceeded`) or `thread_reply_limit` is never retried; a 409
`idempotency_request_in_progress` is.

```ts
const zap = new ZapSMTP({ apiKey: 'zap_...', maxRetries: 4, timeout: 20_000 });
await zap.emails.get(id, { timeout: 5_000, maxRetries: 0 });
```

## Response headers

```ts
const { data, response } = await zap.emails.send(email).withResponse();
console.log(response.requestId, response.headers.get('ratelimit-remaining'));
```

## Webhooks

Check the signature on the raw body, before parsing it:

```ts
import express from 'express';
import { verifyWebhook } from 'zapsmtp';

app.post('/webhooks/zapsmtp', express.raw({ type: 'application/json' }), (req, res) => {
  const event = verifyWebhook(req.body, req.headers, process.env.ZAP_WEBHOOK_SECRET!);
  if (event.type === 'email.bounced') { /* ... */ }
  res.sendStatus(200);
});
```

`verifyWebhook` throws `WebhookVerificationError` when the signature is wrong or older than five minutes.

An endpoint created with `batch: true` receives an array of events; `verifyWebhook` refuses it. Use
`verifyWebhookEvents`, which takes both shapes and returns a list (one element for a single event):

```ts
import { verifyWebhookEvents } from 'zapsmtp';

for (const event of verifyWebhookEvents(req.body, req.headers, process.env.ZAP_WEBHOOK_SECRET!)) {
  handle(event);
}
```

## Configuration

| Option | Environment | Default |
|---|---|---|
| `apiKey` | `ZAP_API_KEY` | required |
| `baseUrl` | `ZAP_BASE_URL` | `https://api.zapsmtp.com/v1` |
| `timeout` | | 60,000 ms per attempt |
| `maxRetries` | | 2 |
| `defaultHeaders` | | |
| `fetch` | | the global `fetch` |

## Reference

Every method is listed with its parameters in the [API reference](https://zapsmtp.com/docs/).
The SDK's resources mirror it: `zap.emails`, `zap.emails.receiving`, `zap.threads`, `zap.domains`,
`zap.webhooks`, `zap.actions`, `zap.templates`, `zap.variables`, `zap.templateModules`,
`zap.templateAssets`, `zap.templateTimers`, `zap.inbound`, `zap.suppressions`, `zap.stats`,
`zap.apiKeys`, `zap.smtpCredentials`, `zap.logs`, `zap.usage`, `zap.account`, `zap.simulator`, `zap.dedicatedIps`.

## Development

The resources and types in `src/generated` are generated from the API reference by `sdks/codegen`;
change the generator, never those files. `npm test` runs every API operation against the conformance
server (`sdks/conformance`) and the core tests.
