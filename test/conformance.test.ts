// Every API operation, called through the SDK against the conformance mock
// (sdks/conformance/server.mjs), which checks the exact request it gets.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Page, ZapSMTP } from '../src/index.js';

const dir = fileURLToPath(new URL('../../conformance/', import.meta.url));
const cases: any[] = JSON.parse(readFileSync(dir + 'cases.json', 'utf8'));

let server: ChildProcess;
let zap: ZapSMTP;

beforeAll(async () => {
  server = spawn(process.execPath, [dir + 'server.mjs', '0']);
  const port = await new Promise<number>((resolve, reject) => {
    server.stdout!.on('data', (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', reject);
  });
  zap = new ZapSMTP('zap_test_conformance', { baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
});
afterAll(() => { server?.kill(); });

describe('conformance', () => {
  it('covers every operation once', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
  for (const c of cases) {
    it(c.id, async () => {
      let target: any = zap;
      for (const r of c.call.resource) target = target[r];
      const fn = target[c.call.method];
      expect(typeof fn).toBe('function');
      const args: unknown[] = [...c.call.pathArgs];
      if (c.call.items) args.push(c.call.items, c.call.options);
      else if (c.call.params) args.push(c.call.params);
      const res = await fn.apply(target, args);
      if (c.response.body === null) expect(res).toBeUndefined();
      else if (res instanceof Page) expect(res.data).toEqual(c.response.body.data);
      else expect(res).toEqual(c.response.body);
    });
  }
});
