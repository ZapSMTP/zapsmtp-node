// nextPage through the public export: the stateless continuation the MCP
// server and the CLI build their cursors and hints from.
import { describe, expect, it } from 'vitest';
import { nextPage, type APIRequest, type PageData, type Paging } from '../src/index.js';

const req: APIRequest = { method: 'GET', path: '/emails', query: { limit: 2, status: 'bounced' } };
const items = [{ id: 'a', last_message_at: 't1' }, { id: 'b', last_message_at: 't2' }];
const page = (data: unknown[], extra: Partial<PageData<unknown>> = {}): PageData<unknown> => ({ object: 'list', data, has_more: true, ...extra });

describe('nextPage', () => {
  it('continues every kind of list, keeping the other query parameters', () => {
    const q = (paging: Paging, p = page(items), r = req) => nextPage(r, p, paging)?.query;
    expect(q('before')).toEqual({ limit: 2, status: 'bounced', before: 'b' });
    expect(q('after')).toEqual({ limit: 2, status: 'bounced', after: 'b' });
    expect(q('logs')).toEqual({ limit: 2, status: 'bounced', before: 'b' });
    expect(q('logs', page(items), { ...req, query: { after: 'z' } })).toEqual({ after: 'a' });
    expect(q('thread')).toEqual({ limit: 2, status: 'bounced', before: 't2', before_id: 'b' });
    expect(q('cursor', page(items, { next_cursor: 'nc' }))).toEqual({ limit: 2, status: 'bounced', after: 'nc' });
    expect(nextPage(req, page(items), 'before')).toMatchObject({ method: 'GET', path: '/emails' });
  });

  it('is null after the last page, without a cursor, or without paging', () => {
    expect(nextPage(req, page(items, { has_more: false }), 'before')).toBeNull();
    expect(nextPage(req, page(items), 'cursor')).toBeNull();
    expect(nextPage(req, page(items), null)).toBeNull();
    expect(nextPage({ method: 'GET', path: '/x' }, page([]), 'logs')).toBeNull();
  });
});
