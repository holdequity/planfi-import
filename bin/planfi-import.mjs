#!/usr/bin/env node
// planfi-import CLI — zero-dependency, Node >= 18 (uses global fetch).
//
//   (adapter ids: plaid | mx | finicity | fdx | csv | ofx — see ADAPTERS)
//   planfi-import demo [--source <id>] [--json]
//       Run a bundled sandbox fixture through importToPlan and pretty-print
//       the plan + warnings + needsInput. No credentials, no network.
//   planfi-import validate <payload> [<payload>…] --source <id> [--json]
//       Run importToPlan on your own payload and print the structured
//       diagnostics. Exit 0 unless the import itself fails (warnings are
//       DIAGNOSTICS, not failures); exit 1 on a hard failure.
//   planfi-import plan <payload> [<payload>…] --source <id> [--token pft_…]
//                 [--user-id <id>] [--base https://api.planfi.app] [--json]
//       Build the plan AND create it for real via
//       POST /v1/tools/generate_financial_plan; prints the plan_id.
//   planfi-import batch <dir-or-ndjson> --source <id> --token pft_…
//                 [--concurrency 4] [--resume manifest.json] [--batch-size 25|--single]
//       Bulk-load thousands of customers through import_financial_data_batch
//       (25 items/call). Filename stem (or the NDJSON "user_id" field) = the
//       customer's user_id — the (account, user_id) upsert identity, so the
//       run is idempotent. Resume manifest + results file written next to the
//       input; re-runs skip already-ok items.
//
// Payload files: JSON for the API-shaped sources (plaid/mx/finicity — the
// merged provider responses). The keyless sources take their files DIRECTLY:
//   planfi-import validate accounts.csv positions.csv --source csv
//   planfi-import validate statement.ofx --source ofx
// (a .json payload also works for csv/ofx, carrying { files | content, owner, asOf }).
//
// Colors: only when stdout is a TTY (and NO_COLOR is unset) — pipe-safe.
// Exit codes: 0 ok · 1 hard failure · 2 usage error.

import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { importToPlan, ADAPTERS } from '../src/index.mjs';

const DEFAULT_BASE = 'https://api.planfi.app';
const KEYLESS = new Set(['csv', 'ofx']);

// ── tiny TTY-aware color helpers ─────────────────────────────────────────────
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);
const red = paint(31);

const USAGE = `planfi-import — turn financial data exports into planfi plans

Usage:
  planfi-import demo [--source plaid|mx|finicity|fdx|csv|ofx] [--json]
  planfi-import validate <payload> [<payload>…] --source <id> [--json]
  planfi-import plan <payload> [<payload>…] --source <id> [--token pft_…] [--user-id <id>] [--base <url>] [--json]
  planfi-import batch <dir-or-ndjson> --source <id> --token pft_…
                [--concurrency 4] [--resume manifest.json]
                [--batch-size 25 | --single] [--base <url>] [--json]

Commands:
  demo       Run the bundled sandbox fixture for a source (default: plaid).
  validate   Import your payload and print structured warnings + needsInput.
             Exits 0 even with warnings (they are diagnostics); 1 on failure.
  plan       Import AND create a real plan via POST /v1/tools/generate_financial_plan.
  batch      Bulk-load MANY customers via import_financial_data_batch (25/call).
             Input: a directory of <user_id>.json payload files (filename stem =
             user_id), or an .ndjson file with {"user_id","payload"[,"plan_name"]}
             per line. (your account, user_id) is a stable upsert identity, so the
             whole run is SAFE TO RE-RUN — re-imports update, never duplicate.
             Writes a resume manifest + results file next to the input; a re-run
             skips items already imported ok. Exits 0 all-ok / 1 if any item failed.

Payloads:
  plaid|mx|finicity|fdx  one .json file: the merged provider API responses.
  csv                one or more .csv files (passed directly), or one .json
                     payload of shape { files: [{name, content}], owner, asOf }.
  ofx                one .ofx/.qfx file (passed directly), or one .json payload.
  batch dir          *.json payload files only (wrap csv/ofx text as their
                     { files: [...] } / { content } JSON payload shapes).

Options:
  --source <id>       adapter id: ${Object.keys(ADAPTERS).join(' | ')}
  --token <tok>       planfi API token (else anonymous free-quota)
  --user-id <id>      end-user id, sent as X-Planfi-User-Id. The API token
                      identifies your (partner) tenant; this attributes the plan
                      and usage to one end user within it — and makes the import
                      an UPSERT (re-import updates that user's plan). Optional.
  --base <url>        API base URL (default ${DEFAULT_BASE})
  --json              machine-readable JSON output (implies no colors)
  --concurrency <n>   batch: parallel in-flight requests (default 4, max 16)
  --resume <path>     batch: manifest path (default <input>.planfi-manifest.json);
                      loaded if present — items already ok are skipped
  --batch-size <n>    batch: items per API call (default 25, the server max)
  --single            batch: one import_financial_data call per item instead of
                      the batch endpoint (full per-item responses; more calls)
  -h, --help          this help
`;

// ── arg parsing (dependency-free) ────────────────────────────────────────────
function parseArgs(argv) {
  const args = { positional: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--single') args.single = true;
    else if (
      a === '--source' || a === '--token' || a === '--base' || a === '--user-id' ||
      a === '--concurrency' || a === '--resume' || a === '--batch-size'
    ) {
      const key = a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      const v = argv[++i];
      if (v == null || v.startsWith('--')) fail(2, `Missing value for ${a}`);
      args[key] = v;
    } else if (a.startsWith('-')) {
      fail(2, `Unknown option: ${a}`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function fail(code, message) {
  if (message) process.stderr.write(red(`error: ${message}`) + '\n\n');
  process.stderr.write(USAGE);
  process.exit(code);
}

// ── payload loading ──────────────────────────────────────────────────────────
/** Build the adapter-native raw payload from the positional file args. */
function loadPayload(files, source) {
  if (!files.length) fail(2, 'No payload file given');
  const isJson = (f) => /\.json$/i.test(f);
  if (!KEYLESS.has(source) || (files.length === 1 && isJson(files[0]))) {
    if (files.length > 1) fail(2, `Source "${source}" takes exactly one .json payload file`);
    return JSON.parse(readFileSync(files[0], 'utf8'));
  }
  if (source === 'csv') {
    return { files: files.map((f) => ({ name: path.basename(f), content: readFileSync(f, 'utf8') })) };
  }
  // ofx: one statement file
  if (files.length > 1) fail(2, 'Source "ofx" takes one statement file');
  return { content: readFileSync(files[0], 'utf8') };
}

async function loadFixture(source) {
  const url = new URL(`../fixtures/${source}-sandbox.mjs`, import.meta.url);
  const mod = await import(url.href);
  const raw = mod[`${source}Raw`];
  if (!raw) throw new Error(`fixtures/${source}-sandbox.mjs does not export ${source}Raw`);
  return raw;
}

// ── human-readable printing ──────────────────────────────────────────────────
const usd = (n) => (Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : String(n));

function printResult({ plan, warnings, needsInput }, source) {
  const out = [];
  out.push(bold(`plan`) + dim(` (source: ${source})`));
  out.push(`  name: ${plan.name}`);
  for (const e of plan.earners ?? []) {
    const bits = [e.age != null ? `age ${e.age}` : null, e.retirement_age != null ? `retire at ${e.retirement_age}` : null,
      e.annual_salary != null ? `${usd(e.annual_salary)}/yr` : null].filter(Boolean).join(', ');
    out.push(`  earner: ${e.name}${bits ? ` (${bits})` : ''}`);
  }
  const ab = plan.account_balances ?? {};
  out.push(`  stocks: ${usd(plan.stocks?.current_value)} ` +
    dim(`(taxable ${usd(ab.taxable)} / traditional ${usd(ab.traditional)} / roth ${usd(ab.roth)})`) +
    (plan.stocks?.monthly_contribution ? ` +${usd(plan.stocks.monthly_contribution)}/mo` : ''));
  out.push(`  cash: ${usd(plan.cash?.current_value)}`);
  for (const p of plan.real_estate ?? []) {
    out.push(`  real estate: ${p.name} ${usd(p.current_value)}` +
      (p.mortgage ? dim(` (mortgage ${usd(p.mortgage.balance)} @ ${(p.mortgage.rate * 100).toFixed(2)}%)`) : ''));
  }
  for (const d of plan.debts ?? []) {
    out.push(`  debt: ${d.name} ${usd(d.balance)}` + dim(` @ ${(d.rate * 100).toFixed(2)}%`));
  }
  if (plan.education_account) out.push(`  education (529): ${usd(plan.education_account.initialBalance)}`);
  for (const s of plan.speculative ?? []) out.push(`  speculative: ${s.name} ${usd(s.current_value)}`);
  if (plan.desired_annual_spend != null) out.push(`  desired spend: ${usd(plan.desired_annual_spend)}/yr`);
  out.push('');

  if (warnings.length) {
    out.push(bold(`warnings (${warnings.length})`) + dim(' — judgment calls the import made; verify them:'));
    for (const w of warnings) {
      const tag = w.severity === 'warn' ? yellow(`[warn]`) : cyan(`[info]`);
      out.push(`  ${tag} ${w.code}${w.accountId ? dim(` (account ${w.accountId})`) : ''}`);
      out.push(dim(`         ${w.message}`));
    }
  } else {
    out.push(green('no warnings'));
  }
  out.push('');

  if (needsInput.length) {
    out.push(bold(`needs input (${needsInput.length})`) + dim(' — collect these from the user, merge into owner, re-run:'));
    for (const n of needsInput) {
      out.push(`  ${cyan(n.field)}: ${n.label}`);
      out.push(dim(`         ${n.why}`));
    }
  } else {
    out.push(green('nothing to collect — the payload carried full planning context'));
  }
  process.stdout.write(out.join('\n') + '\n');
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdDemo(args) {
  const source = args.source ?? 'plaid';
  if (!ADAPTERS[source]) fail(2, `Unknown --source "${source}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  const raw = await loadFixture(source);
  const result = importToPlan(source, raw);
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printResult(result, source);
}

async function cmdValidate(args) {
  const source = args.source ?? fail(2, 'validate requires --source');
  const raw = loadPayload(args.positional, source);
  const result = importToPlan(source, raw);
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printResult(result, source);
  // Warnings/needsInput are structured DIAGNOSTICS, not failures → exit 0.
}

async function cmdPlan(args) {
  const source = args.source ?? fail(2, 'plan requires --source');
  const raw = loadPayload(args.positional, source);
  const { plan, warnings, needsInput } = importToPlan(source, raw);
  const base = (args.base ?? DEFAULT_BASE).replace(/\/$/, '');
  const res = await fetch(`${base}/v1/tools/generate_financial_plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}),
      // The token identifies the partner TENANT; X-Planfi-User-Id attributes
      // the plan/usage to one END USER within it (optional, partner-supplied).
      ...(args.userId ? { 'X-Planfi-User-Id': args.userId } : {}),
    },
    body: JSON.stringify(plan),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    process.stderr.write(red(`error: ${res.status} from ${base}`) + '\n' + dim(text.slice(0, 2000)) + '\n');
    process.exit(1);
  }
  if (args.json) {
    process.stdout.write(JSON.stringify({ plan_id: body.plan_id, response: body, warnings, needsInput }, null, 2) + '\n');
    return;
  }
  process.stdout.write(green('plan created') + `\n  plan_id: ${bold(body.plan_id ?? '(missing from response)')}\n`);
  if (warnings.length) process.stdout.write(yellow(`  ${warnings.length} warning(s)`) + dim(' — re-run `validate` to review them') + '\n');
  if (needsInput.length) process.stdout.write(cyan(`  ${needsInput.length} needsInput field(s)`) + dim(' — collect + patch for a sharper plan') + '\n');
  process.stdout.write(dim(`  every planfi tool now accepts this plan_id (analyze_fire_number, run_backtesting, …)`) + '\n');
}

// ── batch: bulk customer loading via import_financial_data_batch ─────────────

const clampInt = (v, def, min, max) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : def;
};

/**
 * Load the batch work list from a directory of *.json payload files (filename
 * stem = user_id) or an .ndjson file ({user_id, payload[, plan_name, source]}
 * per line). NEVER throws on one bad file/line — the item is recorded with a
 * local error and the rest continue (the CLI mirror of the server's
 * partial-success contract).
 */
function loadBatchItems(input, defaultSource) {
  const items = [];
  const push = (user_id, fn) => {
    try {
      items.push({ user_id, ...fn() });
    } catch (e) {
      items.push({ user_id, error: { code: 'LOCAL_READ_FAILED', message: String(e.message ?? e).slice(0, 300) } });
    }
  };
  const st = statSync(input); // ENOENT throws → caught by main's catch → exit 1
  if (st.isDirectory()) {
    const files = readdirSync(input).filter((f) => /\.json$/i.test(f)).sort();
    if (!files.length) fail(2, `No *.json payload files in ${input}`);
    for (const f of files) {
      push(path.basename(f, path.extname(f)), () => ({
        payload: JSON.parse(readFileSync(path.join(input, f), 'utf8')),
        source: defaultSource,
      }));
    }
    return items;
  }
  // NDJSON: one {"user_id": "...", "payload": {...}} per line.
  const lines = readFileSync(input, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    let row;
    try {
      row = JSON.parse(t);
    } catch (e) {
      items.push({ user_id: `line-${i + 1}`, error: { code: 'LOCAL_PARSE_FAILED', message: `NDJSON line ${i + 1}: ${String(e.message).slice(0, 200)}` } });
      return;
    }
    const uid = typeof row?.user_id === 'string' && row.user_id ? row.user_id : `line-${i + 1}`;
    if (!row || typeof row.payload !== 'object' || row.payload === null) {
      items.push({ user_id: uid, error: { code: 'LOCAL_PARSE_FAILED', message: `NDJSON line ${i + 1}: missing "payload" object` } });
      return;
    }
    items.push({
      user_id: uid,
      payload: row.payload,
      source: typeof row.source === 'string' && row.source ? row.source : defaultSource,
      ...(typeof row.plan_name === 'string' ? { plan_name: row.plan_name } : {}),
    });
  });
  if (!items.length) fail(2, `No NDJSON rows in ${input}`);
  return items;
}

/** The manifest doubles as the RESULTS file — per-user status keyed by user_id. */
function defaultManifestPath(input) {
  return `${input.replace(/[/\\]+$/, '')}.planfi-manifest.json`;
}

function loadManifest(p) {
  if (!existsSync(p)) return { version: 1, items: {} };
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return m && typeof m === 'object' && m.items ? m : { version: 1, items: {} };
  } catch {
    return { version: 1, items: {} }; // corrupt manifest → start fresh, never crash
  }
}

/** Atomic-ish write (tmp + rename) so a crash mid-write can't corrupt the manifest. */
function saveManifest(p, manifest) {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, p);
}

/**
 * Full needsInput objects (field/label/accountId) for the RESULTS file — the
 * per-customer collection worklist. The batch endpoint returns field NAMES per
 * item (rollup-friendly); the CLI has the payload in hand, so it re-runs the
 * SAME library locally (identical code path to the server) for the full asks.
 * Best-effort: a local hiccup yields [] rather than failing the item.
 */
function localDiagnostics(source, payload) {
  try {
    const { warnings, needsInput } = importToPlan(source, payload);
    return {
      warnings: warnings.map((w) => w.code),
      needs_input: needsInput.map((n) => ({
        field: n.field,
        label: n.label,
        ...(n.accountId ? { accountId: n.accountId } : {}),
      })),
    };
  } catch {
    return { warnings: [], needs_input: [] };
  }
}

/** Tiny promise pool: run `worker(task)` over tasks, at most `n` in flight. */
async function pool(tasks, n, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      await worker(tasks[i]);
    }
  });
  await Promise.all(runners);
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, ok: res.ok, json };
}

function printBatchReport(manifest, { skipped }) {
  const rows = Object.entries(manifest.items);
  const oks = rows.filter(([, r]) => r.ok);
  const fails = rows.filter(([, r]) => !r.ok);
  const updatedN = oks.filter(([, r]) => r.updated).length;

  const out = [];
  out.push(bold('batch import report'));
  out.push(`  ${green(`ok: ${oks.length}`)} (${updatedN} updated in place, ${oks.length - updatedN} created)` +
    (skipped ? dim(`  · skipped (already ok in manifest): ${skipped}`) : '') +
    (fails.length ? `  · ${red(`failed: ${fails.length}`)}` : ''));

  // needs_input rollup: field → customers still missing it (the founder view).
  const rollup = {};
  for (const [, r] of oks) for (const n of r.needs_input ?? []) rollup[n.field] = (rollup[n.field] ?? 0) + 1;
  const rollupRows = Object.entries(rollup).sort((a, b) => b[1] - a[1]);
  if (rollupRows.length) {
    out.push('');
    out.push(bold('missing data across the batch') + dim(' (needsInput field → customers):'));
    for (const [field, count] of rollupRows) out.push(`  ${cyan(field.padEnd(22))} ${count}`);
  }
  const wRollup = {};
  for (const [, r] of oks) for (const c of r.warnings ?? []) wRollup[c] = (wRollup[c] ?? 0) + 1;
  const wRows = Object.entries(wRollup).sort((a, b) => b[1] - a[1]);
  if (wRows.length) {
    out.push('');
    out.push(bold('warnings across the batch') + dim(' (code → occurrences):'));
    for (const [code, count] of wRows) out.push(`  ${yellow(code.padEnd(28))} ${count}`);
  }
  if (fails.length) {
    out.push('');
    out.push(bold(`failed items (${fails.length})`) + dim(' — fix + re-run; the manifest skips the done ones:'));
    for (const [uid, r] of fails.slice(0, 25)) {
      out.push(`  ${red(uid)}: ${r.error?.code ?? 'ERROR'} ${dim((r.error?.message ?? '').slice(0, 120))}`);
    }
    if (fails.length > 25) out.push(dim(`  … and ${fails.length - 25} more (see the manifest file)`));
  }
  process.stdout.write(out.join('\n') + '\n');
}

async function cmdBatch(args) {
  const source = args.source ?? fail(2, 'batch requires --source');
  if (!ADAPTERS[source]) fail(2, `Unknown --source "${source}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  const input = args.positional[0] ?? fail(2, 'batch requires a directory of *.json payloads or an .ndjson file');
  const base = (args.base ?? DEFAULT_BASE).replace(/\/$/, '');
  const batchSize = args.single ? 1 : clampInt(args.batchSize, 25, 1, 25);
  const concurrency = clampInt(args.concurrency, 4, 1, 16);
  const manifestPath = args.resume ?? defaultManifestPath(input);

  const all = loadBatchItems(input, source);
  const manifest = loadManifest(manifestPath);
  manifest.source = source;

  // Resume: anything already ok in the manifest is skipped. (The server upsert
  // makes re-sends harmless anyway — skipping just saves quota + time.)
  let skipped = 0;
  const pending = [];
  for (const item of all) {
    if (manifest.items[item.user_id]?.ok) { skipped++; continue; }
    if (item.error) {
      // Locally-unreadable file/line: recorded, never sent, never crashes the run.
      manifest.items[item.user_id] = { ok: false, error: item.error, at: Date.now() };
      continue;
    }
    pending.push(item);
  }

  const record = (item, r) => {
    manifest.items[item.user_id] = { ...r, at: Date.now() };
  };
  const recordOk = (item, res) => {
    record(item, {
      ok: true,
      plan_id: res.plan_id,
      updated: res.updated === true,
      ...localDiagnostics(item.source, item.payload), // full needsInput objects + warning codes
    });
  };

  // Chunk the pending items and drive them through a small worker pool.
  const chunks = [];
  for (let i = 0; i < pending.length; i += batchSize) chunks.push(pending.slice(i, i + batchSize));

  await pool(chunks, concurrency, async (chunk) => {
    try {
      if (args.single) {
        const item = chunk[0];
        const { ok, status, json } = await postJson(`${base}/v1/tools/import_financial_data`, args.token, {
          source: item.source, payload: item.payload, user_id: item.user_id,
          ...(item.plan_name ? { plan_name: item.plan_name } : {}),
        });
        if (ok && json && !json.error) recordOk(item, json);
        else record(item, { ok: false, error: json?.error ?? { code: `HTTP_${status}`, message: `single import returned ${status}` } });
      } else {
        const body = {
          items: chunk.map((it) => ({
            source: it.source, payload: it.payload, user_id: it.user_id,
            ...(it.plan_name ? { plan_name: it.plan_name } : {}),
          })),
        };
        const { ok, status, json } = await postJson(`${base}/v1/tools/import_financial_data_batch`, args.token, body);
        if (!ok || !Array.isArray(json?.results)) {
          const error = json?.error ?? { code: `HTTP_${status}`, message: `batch call returned ${status}` };
          for (const item of chunk) record(item, { ok: false, error });
        } else {
          for (const r of json.results) {
            const item = chunk[r.index];
            if (!item) continue;
            if (r.ok) recordOk(item, r);
            else record(item, { ok: false, error: r.error ?? { code: 'ERROR', message: 'item failed' } });
          }
        }
      }
    } catch (e) {
      // Network-level failure: every item in the chunk is recorded + resumable.
      for (const item of chunk) {
        record(item, { ok: false, error: { code: 'NETWORK', message: String(e.message ?? e).slice(0, 300) } });
      }
    }
    // Persist progress after EVERY chunk so a crash/ctrl-C resumes cleanly.
    saveManifest(manifestPath, manifest);
  });

  saveManifest(manifestPath, manifest);

  const rows = Object.entries(manifest.items);
  const failed = rows.filter(([, r]) => !r.ok).length;
  if (args.json) {
    const rollup = {};
    for (const [, r] of rows) if (r.ok) for (const n of r.needs_input ?? []) rollup[n.field] = (rollup[n.field] ?? 0) + 1;
    process.stdout.write(JSON.stringify({
      summary: { total: all.length, ok: rows.length - failed, failed, skipped },
      needs_input_rollup: rollup,
      manifest: manifestPath,
      results: manifest.items,
    }, null, 2) + '\n');
  } else {
    printBatchReport(manifest, { skipped });
    process.stdout.write(dim(`  manifest/results: ${manifestPath} — re-running skips the ${rows.length - failed} ok item(s)\n`));
  }
  if (failed > 0) process.exit(1);
}

// ── main ─────────────────────────────────────────────────────────────────────
const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (args.help || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(USAGE); process.exit(0); }

const commands = { demo: cmdDemo, validate: cmdValidate, plan: cmdPlan, batch: cmdBatch };
if (!command || !commands[command]) fail(2, command ? `Unknown command: ${command}` : 'No command given');

commands[command](args).catch((e) => {
  process.stderr.write(red(`error: ${e.message}`) + '\n');
  process.exit(1);
});
