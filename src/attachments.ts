// Attachment helpers: content is sent base64-encoded.
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { OutgoingAttachment as Attachment } from './generated/types.js';

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
  '.ics': 'text/calendar', '.json': 'application/json', '.xml': 'application/xml', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** An attachment from bytes or text; the content type follows the file name's extension unless given. */
export function attachment(filename: string, content: Uint8Array | ArrayBuffer | string, options: { contentType?: string; contentId?: string } = {}): Attachment {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content as ArrayBuffer);
  const a: Attachment = { filename, content: bytes.toString('base64') };
  const type = options.contentType ?? TYPES[extname(filename).toLowerCase()];
  if (type) a.content_type = type;
  if (options.contentId) a.content_id = options.contentId;
  return a;
}

/** An attachment read from a file. */
export async function attachmentFromFile(path: string, options: { filename?: string; contentType?: string; contentId?: string } = {}): Promise<Attachment> {
  return attachment(options.filename ?? basename(path), await readFile(path), options);
}
