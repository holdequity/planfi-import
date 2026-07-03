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
//
// Payload files: JSON for the API-shaped sources (plaid/mx/finicity — the
// merged provider responses). The keyless sources take their files DIRECTLY:
//   planfi-import validate accounts.csv positions.csv --source csv
//   planfi-import validate statement.ofx --source ofx
// (a .json payload also works for csv/ofx, carrying { files | content, owner, asOf }).
//
// Colors: only when stdout is a TTY (and NO_COLOR is unset) — pipe-safe.
// Exit codes: 0 ok · 1 hard failure · 2 usage error.

import { readFileSync } from 'node:fs';
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

Commands:
  demo       Run the bundled sandbox fixture for a source (default: plaid).
  validate   Import your payload and print structured warnings + needsInput.
             Exits 0 even with warnings (they are diagnostics); 1 on failure.
  plan       Import AND create a real plan via POST /v1/tools/generate_financial_plan.

Payloads:
  plaid|mx|finicity|fdx  one .json file: the merged provider API responses.
  csv                one or more .csv files (passed directly), or one .json
                     payload of shape { files: [{name, content}], owner, asOf }.
  ofx                one .ofx/.qfx file (passed directly), or one .json payload.

Options:
  --source <id>    adapter id: ${Object.keys(ADAPTERS).join(' | ')}
  --token <tok>    planfi API token (else anonymous free-quota)
  --user-id <id>   end-user id, sent as X-Planfi-User-Id. The API token
                   identifies your (partner) tenant; this attributes the plan
                   and usage to one end user within it. Optional.
  --base <url>     API base URL (default ${DEFAULT_BASE})
  --json           machine-readable JSON output (implies no colors)
  -h, --help       this help
`;

// ── arg parsing (dependency-free) ────────────────────────────────────────────
function parseArgs(argv) {
  const args = { positional: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--source' || a === '--token' || a === '--base' || a === '--user-id') {
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

// ── main ─────────────────────────────────────────────────────────────────────
const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (args.help || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(USAGE); process.exit(0); }

const commands = { demo: cmdDemo, validate: cmdValidate, plan: cmdPlan };
if (!command || !commands[command]) fail(2, command ? `Unknown command: ${command}` : 'No command given');

commands[command](args).catch((e) => {
  process.stderr.write(red(`error: ${e.message}`) + '\n');
  process.exit(1);
});
