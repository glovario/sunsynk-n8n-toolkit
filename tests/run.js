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
  assert.deepStrictEqual(merged, { sellTime5: '16:00', time5On: '0', time5on: 'false', cap5: 50 });
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
test('Plan never arms without a successful query (restores, flags octopus_error)', async () => {
  const cfg = await cfgFor({});
  const p = await run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': { planned: [{ start: '2026-11-02T14:10:00Z', end: '2026-11-02T15:00:00Z' }] } }, now: '2026-11-02T14:05:00Z' });
  assert.strictEqual(p.mode, 'restore'); assert.match(p.octopus_error, /did not succeed/);
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

// ---- Round 2 P1: armed start must not drift across polls in one dispatch
test('successive polls in one active dispatch keep the same armed start and write once', async () => {
  const env = { GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '14:25', GUARD_RESTORE_START: '12:00' };
  const cfg = await cfgFor(env);
  const d = [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }];
  const pstate = {}, gstate = {}; let writes = 0; const starts = [];
  for (const t of ['14:00', '14:10', '14:20', '14:30', '14:40']) {
    const p = await run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': { query_ok: true, device_found: true, planned: d } }, state: pstate, now: `2026-11-02T${t}:00Z` });
    assert.strictEqual(p.mode, 'arm', 'poll ' + t + ' flipped to ' + p.mode);
    starts.push(p.params.sellTime5);
    await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state: gstate, http: async () => { writes++; return { ok: true, dry_run: false }; } });
  }
  assert.deepStrictEqual([...new Set(starts)], ['14:00']);
  assert.strictEqual(writes, 3); // one write (3 commands), then no_change on every later poll
  const p = await run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': { query_ok: true, device_found: true, planned: [] } }, state: pstate, now: '2026-11-02T15:10:00Z' });
  assert.strictEqual(p.mode, 'restore'); assert.strictEqual(pstate.arm, undefined);
});

// ---- Round 2 P2: plug gate must fail closed
for (const [label, http] of [
  ['timeout', async () => { throw new Error('ETIMEDOUT'); }],
  ['401', async () => { const e = new Error('Request failed with status code 401'); e.httpCode = '401'; throw e; }],
  ['unavailable', async () => ({ state: 'unavailable' })],
  ['empty body', async () => ({})],
]) {
  test(`plug gate ${label}: restores instead of arming`, async () => {
    const cfg = await cfgFor({ GUARD_PLUG_STATE_URL: 'http://ha/plug' });
    const p = await plan([{ start: '2026-11-02T14:10:00Z', end: '2026-11-02T15:00:00Z' }], '2026-11-02T14:00:00Z');
    assert.strictEqual(p.mode, 'arm');
    const sent = [];
    const out = await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv,
      http: async (r) => { if (r.url === 'http://ha/plug') return http(); sent.push(r.body); return { ok: true, dry_run: true }; } });
    assert.strictEqual(out.mode, 'restore'); assert.strictEqual(out.plugged, null);
    assert.ok(out.plug_error); assert.match(out.reason, /restoring instead of arming/);
    assert.deepStrictEqual(Object.assign({}, ...sent.map((b) => b.params)), { sellTime5: '16:00', time5On: '0', time5on: 'false', cap5: 50 });
  });
}
test('already-armed slot is restored on plug error and the stored start is cleared', async () => {
  const env = { GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30', GUARD_PLUG_STATE_URL: 'http://ha/plug' };
  const cfg = await cfgFor(env);
  const d = [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }];
  const state = {}; let plug = async () => ({ state: 'on' }); const sent = [];
  const poll = async (t) => {
    const p = await run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': { query_ok: true, device_found: true, planned: d } }, state, now: `2026-11-02T${t}:00Z` });
    return run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state,
      http: async (r) => { if (r.url === 'http://ha/plug') return plug(); sent.push(r.body); return { ok: true, dry_run: false }; } });
  };
  let out = await poll('14:00');
  assert.strictEqual(out.mode, 'arm'); assert.strictEqual(out.action, 'written'); assert.strictEqual(state.arm.start, '14:00');
  sent.length = 0; plug = async () => { throw new Error('ETIMEDOUT'); };
  out = await poll('14:10');
  assert.strictEqual(out.mode, 'restore'); assert.strictEqual(out.action, 'written'); assert.ok(out.plug_error);
  assert.strictEqual(state.arm, undefined);
  assert.deepStrictEqual(Object.assign({}, ...sent.map((b) => b.params)), { sellTime5: '16:00', time5On: '0', time5on: 'false', cap5: 50 });
});
test('plug gate unreadable still allows a restore', async () => {
  const cfg = await cfgFor({ GUARD_PLUG_STATE_URL: 'http://ha/plug' });
  const p = await plan([], '2026-11-02T14:00:00Z');
  const sent = [];
  const out = await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv,
    http: async (r) => { if (r.url === 'http://ha/plug') throw new Error('ETIMEDOUT'); sent.push(r); return { ok: true, dry_run: true }; } });
  assert.strictEqual(out.mode, 'restore'); assert.strictEqual(sent.length, 3);
});
test('plug gate on: arms', async () => {
  const cfg = await cfgFor({ GUARD_PLUG_STATE_URL: 'http://ha/plug' });
  const p = await plan([{ start: '2026-11-02T14:10:00Z', end: '2026-11-02T15:00:00Z' }], '2026-11-02T14:00:00Z');
  const out = await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv,
    http: async (r) => (r.url === 'http://ha/plug' ? { state: 'on' } : { ok: true, dry_run: true }) });
  assert.strictEqual(out.mode, 'arm'); assert.strictEqual(out.plugged, true);
});

// ---- Guard fixes 1: Octopus failure must not leave an armed slot armed past its dispatch
const OCT_FAIL = { error: 'Octopus flexPlannedDispatches failed after 3 tries: ETIMEDOUT. Nothing was changed.' };
const planWith = (cfg, oct, state, now) => run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': oct }, state, now });
test('workflow routes an Octopus Dispatches error into Plan instead of stopping', async () => {
  const node = guard.nodes.find((x) => x.name === 'Octopus Dispatches');
  assert.strictEqual(node.onError, 'continueRegularOutput');
  assert.strictEqual(guard.connections['Octopus Dispatches'].main[0][0].node, 'Plan');
});
test('arm stores the dispatch start and end', async () => {
  const cfg = await cfgFor({}); const state = {};
  const p = await planWith(cfg, { query_ok: true, device_found: true, planned: [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }] }, state, '2026-11-02T14:00:00Z');
  assert.strictEqual(p.mode, 'arm');
  assert.strictEqual(state.arm.end, '2026-11-02T15:00:00.000Z'); assert.strictEqual(state.arm.key, '2026-11-02T13:55:00.000Z');
});
test('Octopus fails mid-dispatch after a verified arm: stays armed with the stored start until the stored end', async () => {
  const cfg = await cfgFor({ GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' }); const state = {};
  const p0 = await planWith(cfg, { query_ok: true, device_found: true, planned: [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }] }, state, '2026-11-02T14:00:00Z');
  await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p0 }, env: baseEnv, state, http: async () => ({ ok: true, dry_run: false }) });
  const p = await planWith(cfg, OCT_FAIL, state, '2026-11-02T14:30:00Z');
  assert.strictEqual(p.mode, 'arm'); assert.strictEqual(p.params.sellTime5, '14:00');
  assert.match(p.octopus_error, /ETIMEDOUT/); assert.ok(state.arm);
});
test('Octopus fails after the stored end: restores and clears the stored arm', async () => {
  const cfg = await cfgFor({}); const state = {};
  await planWith(cfg, { query_ok: true, device_found: true, planned: [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }] }, state, '2026-11-02T14:00:00Z');
  const p = await planWith(cfg, OCT_FAIL, state, '2026-11-02T15:00:00Z');
  assert.strictEqual(p.mode, 'restore'); assert.deepStrictEqual(p.params, p.restore_params);
  assert.match(p.octopus_error, /ETIMEDOUT/); assert.strictEqual(state.arm, undefined);
});
test('Octopus fails with an arm stored without an end (older state): restores', async () => {
  const cfg = await cfgFor({}); const state = { arm: { key: '2026-11-02T13:55:00.000Z', start: '14:00' } };
  const p = await planWith(cfg, OCT_FAIL, state, '2026-11-02T14:10:00Z');
  assert.strictEqual(p.mode, 'restore'); assert.ok(p.octopus_error); assert.strictEqual(state.arm, undefined);
});
test('Octopus fails with nothing armed: restores with an octopus_error diagnostic', async () => {
  const cfg = await cfgFor({});
  const p = await planWith(cfg, OCT_FAIL, {}, '2026-11-02T14:10:00Z');
  assert.strictEqual(p.mode, 'restore'); assert.ok(p.octopus_error);
});
test('end to end: armed, then Octopus down past the dispatch end -> restore is written', async () => {
  const env = { GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' };
  const cfg = await cfgFor(env); const state = {}; const sent = [];
  const poll = async (oct, t) => run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: await planWith(cfg, oct, state, `2026-11-02T${t}:00Z`) }, env: baseEnv, state,
    http: async (r) => { sent.push(r.body); return { ok: true, dry_run: false }; } });
  let out = await poll({ query_ok: true, device_found: true, planned: [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }] }, '14:00');
  assert.strictEqual(out.action, 'written'); sent.length = 0;
  out = await poll(OCT_FAIL, '14:50'); assert.strictEqual(out.action, 'no_change');
  out = await poll(OCT_FAIL, '15:10');
  assert.strictEqual(out.mode, 'restore'); assert.strictEqual(out.action, 'written'); assert.ok(out.octopus_error);
  assert.deepStrictEqual(Object.assign({}, ...sent.map((b) => b.params)), { sellTime5: cfg.restore_start, time5On: '0', time5on: 'false', cap5: 50 });
});

// ---- Guard fixes 2: slot order is wrap-aware (slot 1's previous slot is slot 6 from the day before)
test('GUARD_SLOT=1 arms just after midnight (prev = slot 6 at 23:30)', async () => {
  const env = { GUARD_SLOT: '1', GUARD_PROTECTED_SLOTS: '2,3,4,5,6', GUARD_SLOT_PREV_START: '23:30', GUARD_SLOT_NEXT_START: '05:30', GUARD_RESTORE_START: '00:00',
    GUARD_OFFPEAK_START: '02:00', GUARD_OFFPEAK_END: '04:00' };
  const p = await plan([{ start: '2026-11-02T00:10:00Z', end: '2026-11-02T01:00:00Z' }], '2026-11-02T00:05:00Z', env);
  assert.strictEqual(p.mode, 'arm'); assert.strictEqual(p.params.sellTime1, '00:10');
  const late = await plan([{ start: '2026-11-02T23:40:00Z', end: '2026-11-03T00:20:00Z' }], '2026-11-02T23:35:00Z', env);
  assert.strictEqual(late.mode, 'arm'); assert.strictEqual(late.params.sellTime1, '23:40');
  const bad = await plan([{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' }], '2026-11-02T09:55:00Z', env);
  assert.strictEqual(bad.mode, 'hold');
});
test('GUARD_SLOT=6 (next = slot 1 at 00:00) arms in the evening, holds before slot 5', async () => {
  const env = { GUARD_SLOT: '6', GUARD_PROTECTED_SLOTS: '1,2,3,4,5', GUARD_SLOT_PREV_START: '16:00', GUARD_SLOT_NEXT_START: '00:00', GUARD_RESTORE_START: '19:00' };
  const p = await plan([{ start: '2026-11-02T20:00:00Z', end: '2026-11-02T21:00:00Z' }], '2026-11-02T19:55:00Z', env);
  assert.strictEqual(p.mode, 'arm'); assert.strictEqual(p.params.sellTime6, '20:00');
  const bad = await plan([{ start: '2026-11-02T15:00:00Z', end: '2026-11-02T15:40:00Z' }], '2026-11-02T14:55:00Z', env);
  assert.strictEqual(bad.mode, 'hold');
});
test('middle slot (5) keeps the plain between-neighbours rule', async () => {
  const env = { GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '18:00', GUARD_RESTORE_START: '16:00' };
  assert.strictEqual((await plan([{ start: '2026-11-02T14:10:00Z', end: '2026-11-02T15:00:00Z' }], '2026-11-02T14:00:00Z', env)).mode, 'arm');
  assert.strictEqual((await plan([{ start: '2026-11-02T18:10:00Z', end: '2026-11-02T19:00:00Z' }], '2026-11-02T18:05:00Z', env)).mode, 'hold');
});

// ---- Guard fixes 3: default restore start must not clash with SELL_START; slot starts validated
test('default GUARD_RESTORE_START is not the SELL_START default (18:00)', async () => {
  const cfg = await cfgFor({});
  assert.notStrictEqual(cfg.restore_start, '18:00');
  await cfgFor({ SELL_ENABLED: 'true' }); // defaults alone must pass with Sell on
});
test('GUARD_RESTORE_START equal to SELL_START is rejected', async () => {
  await assert.rejects(cfgFor({ GUARD_RESTORE_START: '18:00', SELL_ENABLED: 'true' }), /GUARD_RESTORE_START.*SELL_START/);
  await assert.rejects(cfgFor({ GUARD_RESTORE_START: '17:00', SELL_START: '17:00', SELL_ENABLED: 'true' }), /GUARD_RESTORE_START.*SELL_START/);
});
test('duplicate neighbour starts are rejected', async () => {
  await assert.rejects(cfgFor({ GUARD_SLOT_PREV_START: '18:00', GUARD_SLOT_NEXT_START: '18:00' }), /duplicate/);
  await assert.rejects(cfgFor({ GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '18:00', GUARD_RESTORE_START: '18:00' }), /duplicate/);
  await assert.rejects(cfgFor({ GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '18:00', GUARD_RESTORE_START: '05:30' }), /duplicate/);
});
test('out-of-order slot starts are rejected in Config', async () => {
  await assert.rejects(cfgFor({ GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '18:00', GUARD_RESTORE_START: '19:00' }), /out of slot order/);
  await assert.rejects(cfgFor({ GUARD_SLOT_PREV_START: '18:00', GUARD_SLOT_NEXT_START: '05:30', GUARD_RESTORE_START: '12:00' }), /out of slot order/); // slot 5 cannot wrap
});
test('Sell as the next slot: GUARD_SLOT_NEXT_START must be SELL_START', async () => {
  await assert.rejects(cfgFor({ SELL_ENABLED: 'true', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' }), /GUARD_SLOT_NEXT_START.*SELL_START/);
  const ok = await cfgFor({ SELL_ENABLED: 'true', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '18:00' });
  assert.strictEqual(ok.slot_next_start, '18:00');
});

// ---- Review 5718795915 P1a: disabled Sell must not constrain the guard
test('SELL_ENABLED=false with SELL_START=18:00 and GUARD_SLOT_NEXT_START=23:30 passes Config', async () => {
  const cfg = await cfgFor({ SELL_ENABLED: 'false', SELL_SLOT: '6', SELL_START: '18:00', GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' });
  assert.strictEqual(cfg.slot_next_start, '23:30');
  await assert.rejects(cfgFor({ SELL_ENABLED: 'false', SELL_START: '18:00', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '18:00', GUARD_RESTORE_START: '19:00' }), /out of slot order/); // guard's own order check stays
});

// ---- Review 5718795915 P1b: outage may keep only an arm that Gate And Send verified
const OUTAGE_ENV = { GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30', GUARD_PLUG_STATE_URL: 'http://ha/plug' };
const DISP = { query_ok: true, device_found: true, planned: [{ start: '2026-11-02T13:55:00Z', end: '2026-11-02T15:00:00Z' }] };
for (const [label, reply, plugState, wantAction] of [
  ['dry-run', { ok: true, dry_run: true }, 'on', 'dry_run'],
  ['failed read-back', { ok: false, dry_run: false, mismatches: ['cap5'] }, 'on', 'write_failed'],
  ['plug-rejected', { ok: true, dry_run: false }, 'off', 'written'],
]) {
  test(`unverified arm (${label}) then Octopus outage restores; no new arm write`, async () => {
    const cfg = await cfgFor(OUTAGE_ENV); const state = {}; const sent = [];
    const gate = (p, r) => run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state,
      http: async (q) => { if (q.url === 'http://ha/plug') return { state: plugState }; sent.push(q.body); return r; } });
    let p = await planWith(cfg, DISP, state, '2026-11-02T14:00:00Z');
    assert.strictEqual(p.mode, 'arm');
    const first = await gate(p, reply); assert.strictEqual(first.action, wantAction);
    sent.length = 0;
    p = await planWith(cfg, OCT_FAIL, state, '2026-11-02T14:10:00Z');   // outage, within the dispatch
    assert.strictEqual(p.mode, 'restore'); assert.ok(p.octopus_error);
    const out = await gate(p, { ok: true, dry_run: false });           // writes now enabled
    assert.strictEqual(out.mode, 'restore');
    for (const b of sent) assert.notStrictEqual(b.params.time5On, '1');
    assert.ok(!sent.some((b) => b.params.cap5 === 100));
  });
}
test('verified arm (written + read back) then outage within the stored end stays armed, no rewrite', async () => {
  const cfg = await cfgFor(OUTAGE_ENV); const state = {}; let writes = 0;
  const gate = (p) => run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state,
    http: async (q) => (q.url === 'http://ha/plug' ? { state: 'on' } : (writes++, { ok: true, dry_run: false })) });
  assert.strictEqual((await gate(await planWith(cfg, DISP, state, '2026-11-02T14:00:00Z'))).action, 'written');
  assert.ok(state.committed_arm);
  const p = await planWith(cfg, OCT_FAIL, state, '2026-11-02T14:40:00Z');
  assert.strictEqual(p.mode, 'arm'); assert.strictEqual(p.params.sellTime5, '14:00');
  const before = writes; assert.strictEqual((await gate(p)).action, 'no_change'); assert.strictEqual(writes, before);
});

// ---- Review 5718875588: static data persists only on successful executions; alert without failing the run
// Run a Code node and return all output items (a node may return none).
async function runAll(src, { nodes = {}, env = {}, state = {}, now } = {}) {
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const fn = new AsyncFn('$', '$env', '$getWorkflowStaticData', 'require', 'Date', src);
  return fn.call({ helpers: {} }, $, env, () => state, require, now ? fakeDate(now) : Date);
}
const nodeOf = (name) => guard.nodes.find((x) => x.name === name);
// One whole execution, as n8n runs it: static data is a copy, saved back only if the execution succeeds
// (https://docs.n8n.io/build/code-in-n8n/cookbook/built-in-methods-and-variables-examples/getworkflowstaticdata/).
// A node error stops the execution unless that node's onError is continueRegularOutput.
async function execute(store, { env = {}, oct, now, http, sendAlert }) {
  const state = JSON.parse(JSON.stringify(store.data || {}));
  const guarded = async (name, f, fallback) => {
    try { return await f(); } catch (e) { if (nodeOf(name) && nodeOf(name).onError === 'continueRegularOutput') return fallback(e); throw e; }
  };
  try {
    const cfg = await cfgFor(env);
    const p = await run(code(guard, 'Plan'), { nodes: { Config: cfg, 'Octopus Dispatches': oct }, state, now });
    const g = await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state, http });
    const res = { plan: p, gate: g, alerts: [] };
    // Downstream of Gate And Send: walk the real connections.
    let items = [{ json: g }], from = 'Gate And Send';
    while (guard.connections[from] && items.length) {
      const next = guard.connections[from].main[0][0].node; const n = nodeOf(next);
      if (n.type === 'n8n-nodes-base.code') {
        items = await guarded(next, () => runAll(n.parameters.jsCode, { nodes: { Config: cfg, Plan: p, 'Gate And Send': g }, env: { ...baseEnv, ...env }, state, now }),
          (e) => [{ json: { error: e.message } }]);
      } else if (n.type === 'n8n-nodes-base.executeWorkflow') {
        const wait = !(n.parameters.options && n.parameters.options.waitForSubWorkflow === false);
        const call = (async () => { res.alerts.push(items.map((i) => i.json)); if (sendAlert) await sendAlert(items.map((i) => i.json)); })();
        if (wait) items = await guarded(next, async () => { await call; return items; }, (e) => [{ json: { error: e.message } }]);
        else { call.catch(() => {}); }   // fire and forget: the sub-workflow's outcome can't fail this execution
      } else throw new Error('harness: unhandled node type ' + n.type);
      from = next;
    }
    store.data = state;
    return { ok: true, ...res };
  } catch (e) { return { ok: false, error: e }; }
}
const ARM_ENV = { GUARD_DRY_RUN: 'false', GUARD_SLOT_PREV_START: '05:30', GUARD_SLOT_NEXT_START: '23:30' };
const disp = (end) => ({ query_ok: true, device_found: true, planned: [{ start: '2026-11-02T13:55:00Z', end }] });
const writer = () => { const w = { n: 0, http: async () => { w.n++; return { ok: true, dry_run: false }; } }; return w; };

test('harness: a failed execution discards its static-data changes', async () => {
  const store = { data: { keep: 1 } };
  const r = await execute(store, { env: { GUARD_SLOT: '9' }, oct: OCT_FAIL, now: '2026-11-02T14:00:00Z' });
  assert.strictEqual(r.ok, false); assert.deepStrictEqual(store.data, { keep: 1 });
});
test('outage executions succeed, so the fallback state is saved', async () => {
  const store = {}; const w = writer();
  const r = await execute(store, { env: ARM_ENV, oct: OCT_FAIL, now: '2026-11-02T14:00:00Z', http: w.http });
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.strictEqual(store.data.octopus_failures, 1); assert.ok(store.data.last);
});
test('repeated outage polls after a verified restore: no repeated writes, failure count climbs', async () => {
  const store = {}; const w = writer();
  let r = await execute(store, { env: ARM_ENV, oct: disp('2026-11-02T15:00:00Z'), now: '2026-11-02T14:00:00Z', http: w.http });
  assert.strictEqual(r.gate.action, 'written');
  r = await execute(store, { env: ARM_ENV, oct: OCT_FAIL, now: '2026-11-02T15:10:00Z', http: w.http });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.gate.mode, 'restore'); assert.strictEqual(r.gate.action, 'written');
  const after = w.n;
  for (const [t, n] of [['15:20', 2], ['15:30', 3], ['15:40', 4]]) {
    r = await execute(store, { env: ARM_ENV, oct: OCT_FAIL, now: `2026-11-02T${t}:00Z`, http: w.http });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.gate.action, 'no_change');
    assert.strictEqual(r.plan.octopus_failures, n); assert.strictEqual(store.data.octopus_failures, n);
  }
  assert.strictEqual(w.n, after);
});
test('dispatch end extended (arm no_change), then Octopus outage: stays armed until the new end', async () => {
  const store = {}; const w = writer();
  let r = await execute(store, { env: ARM_ENV, oct: disp('2026-11-02T15:00:00Z'), now: '2026-11-02T14:00:00Z', http: w.http });
  assert.strictEqual(r.gate.action, 'written');
  r = await execute(store, { env: ARM_ENV, oct: disp('2026-11-02T16:00:00Z'), now: '2026-11-02T14:20:00Z', http: w.http });
  assert.strictEqual(r.gate.action, 'no_change'); assert.strictEqual(store.data.committed_arm.end, '2026-11-02T16:00:00.000Z');
  const before = w.n;
  r = await execute(store, { env: ARM_ENV, oct: OCT_FAIL, now: '2026-11-02T15:30:00Z', http: w.http });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.gate.mode, 'arm'); assert.strictEqual(r.gate.action, 'no_change');
  assert.strictEqual(w.n, before);
  r = await execute(store, { env: ARM_ENV, oct: OCT_FAIL, now: '2026-11-02T16:00:00Z', http: w.http });
  assert.strictEqual(r.gate.mode, 'restore'); assert.strictEqual(r.gate.action, 'written');
});
test('arm no_change does not mark an unverified arm as committed', async () => {
  const cfg = await cfgFor(ARM_ENV); const state = {};
  const p = await planWith(cfg, disp('2026-11-02T16:00:00Z'), state, '2026-11-02T14:20:00Z');
  state.last = JSON.stringify({ mode: 'arm', params: p.params });   // marker present, but no committed_arm
  const out = await run(code(guard, 'Gate And Send'), { nodes: { Config: cfg, Plan: p }, env: baseEnv, state, http: async () => ({ ok: true, dry_run: false }) });
  assert.strictEqual(out.action, 'no_change'); assert.strictEqual(state.committed_arm, undefined);
});
test('alert sub-workflow failing does not fail the execution or lose state', async () => {
  const store = {}; const w = writer();
  const r = await execute(store, { env: { ...ARM_ENV, GUARD_ALERT_WORKFLOW_ID: 'wfAlert1' }, oct: OCT_FAIL, now: '2026-11-02T14:00:00Z', http: w.http,
    sendAlert: async () => { throw new Error('alert workflow broken'); } });
  assert.strictEqual(r.ok, true); assert.strictEqual(store.data.octopus_failures, 1); assert.ok(store.data.last);
  assert.strictEqual(r.alerts.length, 1);
  assert.match(r.alerts[0][0].message, /Octopus unavailable \(1 consecutive run/);
});
test('alert nodes: Octopus Alert never throws; Send Alert is fire-and-forget with continue on error', async () => {
  assert.strictEqual(guard.connections['Gate And Send'].main[0][0].node, 'Octopus Alert');
  assert.ok(!/throw /.test(code(guard, 'Octopus Alert')));
  assert.strictEqual(nodeOf('Octopus Alert').onError, 'continueRegularOutput');
  assert.strictEqual(guard.connections['Octopus Alert'].main[0][0].node, 'Send Alert');
  const s = nodeOf('Send Alert');
  assert.strictEqual(s.type, 'n8n-nodes-base.executeWorkflow'); assert.strictEqual(s.onError, 'continueRegularOutput');
  assert.strictEqual(s.parameters.options.waitForSubWorkflow, false);
  assert.match(JSON.stringify(s.parameters.workflowId), /alert_workflow_id/);
});
test('Octopus Alert sends only when Octopus failed and GUARD_ALERT_WORKFLOW_ID is set', async () => {
  const src = code(guard, 'Octopus Alert');
  const g = { mode: 'restore', action: 'written', octopus_error: 'boom', octopus_failures: 3 };
  const with_ = await cfgFor({ GUARD_ALERT_WORKFLOW_ID: 'wfAlert1' }), without = await cfgFor({});
  assert.strictEqual(without.alert_workflow_id, '');
  assert.deepStrictEqual(await runAll(src, { nodes: { Config: without, 'Gate And Send': g } }), []);
  assert.deepStrictEqual(await runAll(src, { nodes: { Config: with_, 'Gate And Send': { ...g, octopus_error: null } } }), []);
  const [item] = await runAll(src, { nodes: { Config: with_, 'Gate And Send': g } });
  assert.strictEqual(item.json.alert_workflow_id, 'wfAlert1');
  assert.match(item.json.message, /Octopus unavailable \(3 consecutive runs\).*boom.*mode=restore.*action=written/);
});
test('consecutive Octopus failures are counted and reset on success', async () => {
  const cfg = await cfgFor({}); const state = {};
  assert.strictEqual((await planWith(cfg, OCT_FAIL, state, '2026-11-02T14:00:00Z')).octopus_failures, 1);
  assert.strictEqual((await planWith(cfg, OCT_FAIL, state, '2026-11-02T14:10:00Z')).octopus_failures, 2);
  assert.strictEqual((await planWith(cfg, { query_ok: true, device_found: true, planned: [] }, state, '2026-11-02T14:20:00Z')).octopus_failures, 0);
});
test('Octopus throw no longer claims nothing was changed', async () => {
  assert.ok(!/Nothing was changed/.test(code(guard, 'Octopus Dispatches')));
});

(async () => {
  let fail = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
  }
  console.log(`\n${tests.length - fail}/${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();
