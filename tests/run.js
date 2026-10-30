#!/usr/bin/env node
// Offline tests: runs the real Code-node source from workflows/*.json with mocked n8n globals.
// No network, no inverter. Usage: node tests/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const wf = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', f), 'utf8'));
const code = (w, name) => w.nodes.find((n) => n.name === name).parameters.jsCode;
const guard = wf('io-ev-guard.json');
const control = wf('sunsynk-control.json');
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

function fakeDate(iso) {
  const fixed = new Date(iso).getTime();
  return class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
}

// Run one Code node. nodes: outputs of earlier nodes by name. http: async (req) => response.
async function run(src, { nodes = {}, env = {}, state = {}, http, now, req = require } = {}) {
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const fn = new AsyncFn('$', '$env', '$getWorkflowStaticData', 'require', 'Date', src);
  const out = await fn.call({ helpers: { httpRequest: http || (async () => { throw new Error('no http'); }) } },
    $, env, () => state, req, now ? fakeDate(now) : Date);
  return out[0].json;
}

const baseEnv = { OCTOPUS_API_KEY: 'sk_test', OCTOPUS_ACCOUNT: 'A-TEST', SUNSYNK_INVERTER_SN: '0000000000', OCTOPUS_RETRY_DELAY_MS: '0' };
const cfgFor = (env) => run(code(guard, 'Config'), { env: { ...baseEnv, ...env } });
const plan = async (planned, now, env = {}) => {
  const cfg = await cfgFor(env);
  return run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': { query_ok: true, device_found: true, planned } }, now });
};

const tests = [];
const test = (name, f) => tests.push([name, f]);

// ---- Finding 1: arm -> unplugged
test('arm then unplugged writes the restore settings, not the arm ones', async () => {
  const cfg = await cfgFor({ GUARD_PLUG_STATE_URL: 'http://ha/plug' });
  const p = await plan([{ start: '2026-11-02T14:10:00Z', end: '2026-11-02T15:00:00Z' }], '2026-11-02T14:00:00Z');
  assert.strictEqual(p.mode, 'arm');
  const sent = [];
  const out = await run(code(guard, 'Gate And Send'), {
    nodes: { Config: cfg, Plan: p }, env: baseEnv,
    http: async (r) => { if (r.url === 'http://ha/plug') return { state: 'off' }; sent.push(r.body); return { ok: true, dry_run: true }; },
  });
  assert.strictEqual(out.mode, 'restore');
  const merged = Object.assign({}, ...sent.map((b) => b.params));
  assert.deepStrictEqual(merged, { sellTime5: '18:00', time5On: '0', time5on: 'false', cap5: 50 });
});

// ---- Finding 2: dry-run response must not be cached
test('dry-run reply is not cached; first real write after enabling goes through', async () => {
  const cfg = await cfgFor({ GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' });
  const p = await plan([], '2026-11-02T14:00:00Z', { GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' });
  const state = {};
  let reply = { ok: true, dry_run: true }, calls = 0;
  const gate = () => run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state, http: async () => { calls++; return reply; } });
  let out = await gate();
  assert.strictEqual(out.action, 'dry_run'); assert.strictEqual(state.last, undefined);
  reply = { ok: true, dry_run: false };   // SUNSYNK_WRITES_ENABLED switched on
  out = await gate();
  assert.strictEqual(out.action, 'written'); assert.ok(state.last);
  const before = calls; out = await gate();
  assert.strictEqual(out.action, 'no_change'); assert.strictEqual(calls, before);
  reply = { ok: false, dry_run: false, mismatches: ['cap5'] }; delete state.last;
  out = await gate();
  assert.strictEqual(out.action, 'write_failed'); assert.strictEqual(state.last, undefined);
});

// ---- Finding 3: API / GraphQL errors
async function octo(responses) {
  const cfg = await cfgFor({});
  let i = 0;
  return run(code(guard, 'Octopus Dispatches'), { nodes: { Config: cfg }, env: baseEnv, http: async () => {
    const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r; } });
}
const TOK = { data: { obtainKrakenToken: { token: 't' } } };
const DEV = { data: { devices: [{ id: 'd1', deviceType: 'ELECTRIC_VEHICLES' }] } };
test('GraphQL error on devices query throws (no restore)', async () => {
  await assert.rejects(octo([TOK, { errors: [{ message: 'boom' }], data: null }]), /devices failed.*boom/);
});
test('missing flexPlannedDispatches data throws', async () => {
  await assert.rejects(octo([TOK, DEV, { data: { flexPlannedDispatches: null } }]), /flexPlannedDispatches failed/);
  await assert.rejects(octo([TOK, DEV, { data: null }]), /flexPlannedDispatches failed/);
  await assert.rejects(octo([TOK, DEV, { errors: [{ message: 'x' }], data: { flexPlannedDispatches: [] } }]), /GraphQL error/);
});
test('network error is retried, then succeeds', async () => {
  const out = await octo([TOK, DEV, new Error('ECONNRESET'), { data: { flexPlannedDispatches: [] } }]);
  assert.deepStrictEqual(out.planned, []); assert.strictEqual(out.query_ok, true);
});
test('Plan refuses to run without a successful query', async () => {
  const cfg = await cfgFor({});
  await assert.rejects(run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': { planned: [] } } }), /did not succeed/);
});

// ---- Finding 4: tomorrow / far-future dispatch
test('dispatch tomorrow at 13:00 does not arm today', async () => {
  const p = await plan([{ start: '2026-11-03T13:00:00Z', end: '2026-11-03T14:00:00Z' }], '2026-11-02T14:00:00Z');
  assert.strictEqual(p.mode, 'restore'); assert.strictEqual(p.next_extra_start, '2026-11-03T13:00:00.000Z');
});
test('dispatch later today beyond lead-in waits; within lead-in arms', async () => {
  let p = await plan([{ start: '2026-11-02T16:00:00Z', end: '2026-11-02T17:00:00Z' }], '2026-11-02T14:00:00Z');
  assert.strictEqual(p.mode, 'restore');
  p = await plan([{ start: '2026-11-02T16:00:00Z', end: '2026-11-02T17:00:00Z' }], '2026-11-02T15:45:00Z');
  assert.strictEqual(p.mode, 'arm'); assert.strictEqual(p.params.sellTime5, '16:00');
});
test('arm start out of slot order holds instead of writing', async () => {
  const env = { GUARD_SLOT_PREV_START: '15:00', GUARD_SLOT_NEXT_START: '18:00' };
  const p = await plan([{ start: '2026-11-02T14:10:00Z', end: '2026-11-02T15:00:00Z' }], '2026-11-02T14:00:00Z', env);
  assert.strictEqual(p.mode, 'hold');
  const out = await run(code(guard, 'Gate And Send'), { nodes: { Config: await cfgFor(env), Plan: p }, env: baseEnv, http: async () => { throw new Error('must not call'); } });
  assert.strictEqual(out.action, 'skipped');
});
test('dry run off without slot neighbours is a config error', async () => {
  await assert.rejects(cfgFor({ GUARD_DRY_RUN: 'false' }), /GUARD_SLOT_PREV_START/);
});

// ---- Finding 6: UK clock changes (off-peak 23:30-05:30 local)
test('spring forward (28 Mar 2027): 05:30 BST = 04:30Z ends off-peak', async () => {
  const p = await plan([{ start: '2027-03-28T04:00:00Z', end: '2027-03-28T05:00:00Z' }], '2027-03-28T04:20:00Z');
  assert.strictEqual(p.extra_count, 1); assert.strictEqual(p.extra_start, '2027-03-28T04:30:00.000Z');
  assert.strictEqual(p.mode, 'arm'); assert.strictEqual(p.params.sellTime5, '05:30');
});
test('fall back (25 Oct 2026): 04:30Z-05:30Z is still off-peak (05:30 GMT)', async () => {
  const p = await plan([{ start: '2026-10-25T04:30:00Z', end: '2026-10-25T05:30:00Z' }], '2026-10-25T04:00:00Z');
  assert.strictEqual(p.extra_count, 0); assert.strictEqual(p.mode, 'restore');
});
test('fall back: off-peak start 23:30 BST = 22:30Z the night before', async () => {
  const p = await plan([{ start: '2026-10-24T22:00:00Z', end: '2026-10-24T23:00:00Z' }], '2026-10-24T21:50:00Z');
  assert.strictEqual(p.extra_count, 1); assert.strictEqual(p.extra_end, '2026-10-24T22:30:00.000Z');
});

// ---- Finding 5: crypto blocked
test('blocked crypto gives a clear error', async () => {
  const blocked = () => { throw new Error("Cannot find module 'crypto'"); };
  await assert.rejects(run(code(control, 'Sunsynk Login'), { env: { SUNSYNK_USERNAME: 'u', SUNSYNK_PASSWORD: 'p' }, req: blocked }), /NODE_FUNCTION_ALLOW_BUILTIN=crypto/);
});

(async () => {
  let fail = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
  }
  console.log(`\n${tests.length - fail}/${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();
