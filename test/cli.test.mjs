// cli.test.mjs — the bin/planfi-import.mjs CLI, exercised the way users hit
// it: real child-process spawns (argv → exit code → stdout/stderr), and the
// `plan` command against a LOCAL mock HTTP server (node:http) — the real API
// is never called from tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plaidRaw } from '../fixtures/plaid-sandbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/planfi-import.mjs');

/** Spawn the CLI; resolve { code, stdout, stderr } (never rejects). */
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

// ── temp payload files + mock API server ─────────────────────────────────────
let dir;
let server;
let base;
const seenRequests = [];

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'planfi-import-cli-'));
  writeFileSync(path.join(dir, 'plaid.json'), JSON.stringify(plaidRaw));
  writeFileSync(path.join(dir, 'accounts.csv'), [
    'Account Name,Type,Balance',
    'Checking,Checking,"$5,000.00"',
    'Old Mortgage,Mortgage,"$200,000.00"', // no rate/value → warnings + asks
  ].join('\n'));
  writeFileSync(path.join(dir, 'statement.ofx'),
    'OFXHEADER:100\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>4242\n<ACCTTYPE>SAVINGS\n</BANKACCTFROM><LEDGERBAL><BALAMT>750.25\n<DTASOF>20260702\n</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>');
  writeFileSync(path.join(dir, 'not-json.json'), '{ this is not json');

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenRequests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.url === '/v1/tools/generate_financial_plan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plan_id: 'plan_test_123', fire_age: 55 }));
      } else if (req.url === '/broken/v1/tools/generate_financial_plan') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid plan body' }));
      } else {
        res.writeHead(404); res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ── demo ─────────────────────────────────────────────────────────────────────

test('demo (default plaid) prints a human-readable plan and exits 0', async () => {
  const r = await cli(['demo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Imported plan \(plaid\)/);
  assert.match(r.stdout, /warnings \(\d+\)/);
  assert.doesNotMatch(r.stdout, /\x1b\[/, 'no ANSI colors when not a TTY');
});

test('demo --json emits the full machine-readable ImportResult for every source', async () => {
  for (const source of ['plaid', 'mx', 'finicity', 'fdx', 'csv', 'ofx']) {
    const r = await cli(['demo', '--source', source, '--json']);
    assert.equal(r.code, 0, `${source}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.cfp.source, source);
    assert.ok(Array.isArray(out.warnings) && Array.isArray(out.needsInput));
    assert.ok(out.plan.earners.length >= 1);
  }
});

test('demo with an unknown source is a usage error (exit 2) naming the known ids', async () => {
  const r = await cli(['demo', '--source', 'quickbooks']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /plaid.*mx.*finicity.*fdx.*csv.*ofx/s);
});

// ── validate ─────────────────────────────────────────────────────────────────

test('validate a plaid .json payload → exit 0 with structured diagnostics', async () => {
  const r = await cli(['validate', path.join(dir, 'plaid.json'), '--source', 'plaid', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.plan.stocks.current_value > 0);
  assert.ok(out.warnings.every((w) => w.code && w.severity && w.message));
});

test('validate accepts CSV file paths directly (keyless path) and warnings do NOT fail the exit code', async () => {
  const r = await cli(['validate', path.join(dir, 'accounts.csv'), '--source', 'csv', '--json']);
  assert.equal(r.code, 0, 'warnings are diagnostics, not failures: ' + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.warnings.length > 0, 'the mortgage row must produce warnings');
  assert.ok(out.needsInput.some((n) => n.field === 'home_value'));
  assert.equal(out.plan.cash.current_value, 5000);
});

test('validate accepts an OFX file path directly', async () => {
  const r = await cli(['validate', path.join(dir, 'statement.ofx'), '--source', 'ofx', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.plan.cash.current_value, 750);
});

test('validate hard failures exit 1: missing file, malformed json', async () => {
  const missing = await cli(['validate', path.join(dir, 'nope.json'), '--source', 'plaid']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /error:/);
  const badJson = await cli(['validate', path.join(dir, 'not-json.json'), '--source', 'plaid']);
  assert.equal(badJson.code, 1);
});

test('validate without --source is a usage error (exit 2)', async () => {
  const r = await cli(['validate', path.join(dir, 'plaid.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage:/);
});

// ── plan (against the mock server — never the real API) ─────────────────────

test('plan POSTs the wire body and prints the plan_id; --user-id → X-Planfi-User-Id header', async () => {
  seenRequests.length = 0;
  const r = await cli(['plan', path.join(dir, 'plaid.json'), '--source', 'plaid',
    '--token', 'pft_test_abc', '--user-id', 'user-777', '--base', base]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /plan_test_123/);
  const req = seenRequests[0];
  assert.equal(req.url, '/v1/tools/generate_financial_plan');
  assert.equal(req.headers.authorization, 'Bearer pft_test_abc');
  assert.equal(req.headers['x-planfi-user-id'], 'user-777', 'the end-user attribution header must arrive');
  assert.ok(req.body.stocks.current_value > 0, 'the POSTed body is the emitted plan');
});

test('plan without --user-id / --token sends neither header (anonymous path)', async () => {
  seenRequests.length = 0;
  const r = await cli(['plan', path.join(dir, 'accounts.csv'), '--source', 'csv', '--base', base, '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).plan_id, 'plan_test_123');
  const req = seenRequests[0];
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers['x-planfi-user-id'], undefined, 'no flag → no header');
});

test('plan surfaces a non-2xx API response as exit 1 with the body', async () => {
  const r = await cli(['plan', path.join(dir, 'plaid.json'), '--source', 'plaid', '--base', `${base}/broken`]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /400/);
  assert.match(r.stderr, /invalid plan body/);
});

// ── usage / help ─────────────────────────────────────────────────────────────

test('unknown commands and flags → help + exit 2; --help → exit 0', async () => {
  const badCmd = await cli(['frobnicate']);
  assert.equal(badCmd.code, 2);
  assert.match(badCmd.stderr, /Unknown command/);
  assert.match(badCmd.stderr, /Usage:/);
  const badFlag = await cli(['demo', '--frobnicate']);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /Unknown option/);
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /X-Planfi-User-Id/);
});
