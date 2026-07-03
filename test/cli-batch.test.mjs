// cli-batch.test.mjs — the `batch` command, exercised the way partners run it:
// real child-process spawns against a LOCAL mock of the planfi batch API (the
// real API is never called). The contracts under test: user_id from filename
// stem / NDJSON field, chunking through import_financial_data_batch, --single
// fallback, the resume manifest (skip already-ok items), partial failure
// recorded without crashing, and never dying on one malformed file.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plaidRaw } from '../fixtures/plaid-sandbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/planfi-import.mjs');

function cli(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1' }, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

// ── mock batch API ────────────────────────────────────────────────────────────
let server;
let base;
let seenRequests = [];
// Per-test behavior switch: user_ids listed here fail server-side.
let failUserIds = new Set();

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seenRequests.push({ url: req.url, headers: req.headers, body: parsed });
      if (req.url === '/v1/tools/import_financial_data_batch') {
        const items = parsed?.items ?? [];
        const results = items.map((it, index) => failUserIds.has(it.user_id)
          ? { index, user_id: it.user_id, ok: false, needs_input: [], needs_input_count: 0, warnings_count: 0,
              error: { code: 'IMPORT_FAILED', message: 'mock adapter rejection' } }
          : { index, user_id: it.user_id, ok: true, plan_id: `pl_${it.user_id}`, updated: it.user_id.endsWith('-again'),
              needs_input: ['age'], needs_input_count: 1, warnings_count: 0 });
        const failed = results.filter((r) => !r.ok).length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results, summary: { ok: results.length - failed, failed, needs_input_rollup: {}, warnings_rollup: {} } }));
      } else if (req.url === '/v1/tools/import_financial_data') {
        const uid = parsed?.user_id ?? '';
        if (failUserIds.has(uid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'IMPORT_FAILED', message: 'mock adapter rejection' } }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ plan_id: `pl_${uid}`, updated: false, plan: {}, warnings: [], needsInput: [], source: parsed.source, user_id: uid }));
        }
      } else {
        res.writeHead(404); res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

beforeEach(() => {
  seenRequests = [];
  failUserIds = new Set();
});

/** Fresh temp dir with N valid plaid payload files named <user_id>.json. */
function payloadDir(userIds) {
  const dir = mkdtempSync(path.join(tmpdir(), 'planfi-batch-'));
  const payloads = path.join(dir, 'payloads');
  mkdirSync(payloads);
  for (const uid of userIds) writeFileSync(path.join(payloads, `${uid}.json`), JSON.stringify(plaidRaw));
  return { dir, payloads, manifest: `${payloads}.planfi-manifest.json` };
}

// ── directory mode: user_id from the filename stem ───────────────────────────

test('batch <dir>: filename stem becomes user_id; items flow through the batch endpoint; results file written', async (t) => {
  const { dir, payloads, manifest } = payloadDir(['cust-001', 'cust-002', 'cust-003']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ok: 3/);

  // ONE batch call carried all 3 items (default batch-size 25), auth attached.
  const batchCalls = seenRequests.filter((q) => q.url.endsWith('_batch'));
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].headers.authorization, 'Bearer pft_test');
  assert.deepEqual(batchCalls[0].body.items.map((i) => i.user_id), ['cust-001', 'cust-002', 'cust-003']);

  // The manifest doubles as the results file: keyed by user_id, with plan_id
  // and FULL needsInput objects (field/label) for collection worklists.
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(m.items['cust-002'].ok, true);
  assert.equal(m.items['cust-002'].plan_id, 'pl_cust-002');
  assert.ok(Array.isArray(m.items['cust-002'].needs_input));
  for (const n of m.items['cust-002'].needs_input) {
    assert.equal(typeof n.field, 'string');
    assert.equal(typeof n.label, 'string');
  }
});

test('batch --batch-size chunks the load into multiple calls', async (t) => {
  const { dir, payloads } = payloadDir(['u1', 'u2', 'u3', 'u4', 'u5']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base,
    '--batch-size', '2', '--concurrency', '1']);
  assert.equal(r.code, 0, r.stderr);
  const batchCalls = seenRequests.filter((q) => q.url.endsWith('_batch'));
  assert.equal(batchCalls.length, 3); // 2+2+1
});

// ── resume: already-ok items are skipped ─────────────────────────────────────

test('resume skips completed items (manifest re-read on restart; only the failed one is re-sent)', async (t) => {
  const { dir, payloads, manifest } = payloadDir(['done-1', 'done-2', 'retry-me']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // First run: retry-me fails server-side; the other two land ok.
  failUserIds = new Set(['retry-me']);
  const r1 = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base]);
  assert.equal(r1.code, 1, 'partial failure exits 1');
  const m1 = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(m1.items['done-1'].ok, true);
  assert.equal(m1.items['retry-me'].ok, false);
  assert.equal(m1.items['retry-me'].error.code, 'IMPORT_FAILED');

  // Second run: server fixed; ONLY retry-me goes over the wire.
  failUserIds = new Set();
  seenRequests = [];
  const r2 = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /skipped[^\n]*2/);
  const sent = seenRequests.filter((q) => q.url.endsWith('_batch')).flatMap((q) => q.body.items.map((i) => i.user_id));
  assert.deepEqual(sent, ['retry-me']);
  const m2 = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(m2.items['retry-me'].ok, true);
});

// ── partial failure + malformed input never crash the run ───────────────────

test('one malformed payload file is recorded as a local error; the rest import; exit 1', async (t) => {
  const { dir, payloads, manifest } = payloadDir(['good-1', 'good-2']);
  writeFileSync(path.join(payloads, 'broken.json'), '{ not json at all');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base]);
  assert.equal(r.code, 1, 'a failed item exits 1');
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(m.items['good-1'].ok, true);
  assert.equal(m.items['good-2'].ok, true);
  assert.equal(m.items['broken'].ok, false);
  assert.equal(m.items['broken'].error.code, 'LOCAL_READ_FAILED');
  // The malformed file never went over the wire.
  const sent = seenRequests.flatMap((q) => q.body.items?.map((i) => i.user_id) ?? []);
  assert.ok(!sent.includes('broken'));
});

test('a server-side per-item failure is recorded per user_id while its chunk-mates succeed', async (t) => {
  const { dir, payloads, manifest } = payloadDir(['ok-a', 'bad-b', 'ok-c']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  failUserIds = new Set(['bad-b']);
  const r = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base, '--json']);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.summary.ok, 2);
  assert.equal(out.summary.failed, 1);
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(m.items['ok-a'].ok, true);
  assert.equal(m.items['bad-b'].ok, false);
  assert.equal(m.items['ok-c'].ok, true);
});

// ── --single mode + NDJSON input ─────────────────────────────────────────────

test('--single sends one import_financial_data call per item (with per-item user_id in the body)', async (t) => {
  const { dir, payloads } = payloadDir(['s1', 's2']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test', '--base', base, '--single']);
  assert.equal(r.code, 0, r.stderr);
  const singles = seenRequests.filter((q) => q.url === '/v1/tools/import_financial_data');
  assert.equal(singles.length, 2);
  assert.deepEqual(singles.map((q) => q.body.user_id).sort(), ['s1', 's2']);
  assert.equal(seenRequests.filter((q) => q.url.endsWith('_batch')).length, 0);
});

test('NDJSON input: user_id/payload per line; a bad line is recorded, the rest continue', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'planfi-ndjson-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nd = path.join(dir, 'customers.ndjson');
  writeFileSync(nd, [
    JSON.stringify({ user_id: 'nd-1', payload: plaidRaw }),
    'this line is not json',
    JSON.stringify({ user_id: 'nd-2', payload: plaidRaw, plan_name: 'ND Two' }),
    JSON.stringify({ user_id: 'nd-3' }), // missing payload
  ].join('\n'));

  const r = await cli(['batch', nd, '--source', 'plaid', '--token', 'pft_test', '--base', base]);
  assert.equal(r.code, 1, 'bad lines count as failures');
  const m = JSON.parse(readFileSync(`${nd}.planfi-manifest.json`, 'utf8'));
  assert.equal(m.items['nd-1'].ok, true);
  assert.equal(m.items['nd-2'].ok, true);
  assert.equal(m.items['line-2'].error.code, 'LOCAL_PARSE_FAILED');
  assert.equal(m.items['nd-3'].error.code, 'LOCAL_PARSE_FAILED');
  // plan_name rode through to the wire.
  const sentNames = seenRequests.flatMap((q) => q.body.items?.map((i) => i.plan_name) ?? []);
  assert.ok(sentNames.includes('ND Two'));
});

// ── resilience: the whole API being down still exits cleanly + resumably ─────

test('network failure marks every pending item resumable (NETWORK) instead of crashing', async (t) => {
  const { dir, payloads, manifest } = payloadDir(['n1', 'n2']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await cli(['batch', payloads, '--source', 'plaid', '--token', 'pft_test',
    '--base', 'http://127.0.0.1:1']); // nothing listens here
  assert.equal(r.code, 1);
  assert.ok(existsSync(manifest), 'manifest still written');
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(m.items['n1'].error.code, 'NETWORK');
  assert.equal(m.items['n2'].error.code, 'NETWORK');
});
