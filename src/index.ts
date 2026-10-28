export { ZapSMTP } from './generated/client.js';
export * from './generated/client.js';
export type * from './generated/types.js';
export {
  APIPromise, AuthenticationError, ConflictError, ConnectionError, NotFoundError, Page, PagePromise, PermissionError,
  RateLimitError, ServerError, ValidationError, ZapSMTPError,
  type ClientOptions, type PageData, type RequestOptions, type ResponseInfo,
} from './core.js';
export { nextPage, type Paging, type Request as APIRequest } from './core.js';
export { verifyWebhook, verifyWebhookEvents, WebhookVerificationError, type VerifyOptions, type WebhookEvent } from './webhooks.js';
export { attachment, attachmentFromFile } from './attachments.js';
export { VERSION } from './version.js';
export { ZapSMTP as default } from './generated/client.js';
