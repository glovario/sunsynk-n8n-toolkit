# Safety model

These workflows write to a live inverter. This page lists every way they avoid a wrong write, taken from the code.

## Dry run by default

Out of the box, nothing writes:
- `SUNSYNK_WRITES_ENABLED=false`
- `GUARD_DRY_RUN=true`
- `SELL_ENABLED=false`, `SELL_DRY_RUN=true`
- `SELL_WRITE_ENABLE_FLAG=false`

In dry run, Control still validates the request and logs in, but returns `would_write` instead of calling the set API.

## Write gates

A real write needs every one of these.

**Control.**
- `SUNSYNK_WRITES_ENABLED=true`, **and** the request says `"dry_run": false`. Control treats anything else as dry run.

**The calling workflow.**
- Guard: `GUARD_DRY_RUN=false`.
- Sell: `SELL_DRY_RUN=false` **and** `SELL_ENABLED=true`.

**Webhook.**
- A Header Auth key, so only callers with `SUNSYNK_CONTROL_HEADER_VALUE` can reach Control.

**Field allow-list.**
- Only timer fields (`sellTimeN`, `timeNOn`/`timeNon`, `capN`, `sellTimeNEn`) for slots 1–6, each tied to its own command.
- `sellTimeN` must be `HH:MM`, and `capN` must be 10–100.

**Guard limits.**
- The guard writes only `GUARD_SLOT`, which can't be in `GUARD_PROTECTED_SLOTS`, and it never writes `sellTimeNEn`.

**Leaving dry run.**
- The guard won't leave dry run without the slot neighbours.

**Sell limits.**
- Sell refuses to use the guard's slot.

## Read-back verification

- After every real write, Control reads the settings back and compares them field by field, so a "success" reply that changed nothing shows up in `mismatches`.
- The guard saves its stop marker only if all three replies are `ok: true` and `dry_run: false`. If any reply isn't, the marker is deleted and the next run tries again.
- Dry-run replies are never cached, so turning writes on takes effect on the next run.

## Fail-closed paths

| Situation | What happens |
|---|---|
| Bad or missing guard settings | Config stops with every problem listed. Nothing sent. |
| **Octopus fails** (token, device or dispatch query: network, GraphQL `errors`, no `data`, missing field, after retries) | `Octopus Dispatches` continues on error and passes `{ error }` to `Plan`. It is never treated as "no dispatches". `Plan` keeps the slot armed only if `Gate And Send` verified an arm for that same dispatch (`committed_arm`, saved after a successful read-back) and the stored dispatch end hasn't passed. Otherwise it plans a **restore**, which `Gate And Send` writes. `Octopus Alert` then fails the execution, so n8n's error workflow fires (see [Alerting on Octopus failures](#alerting-on-octopus-failures)). |
| No EV or charger on the account | Run stops. Nothing changed. |
| A dispatch with a bad start/end | Run stops. Nothing changed. |
| Plan runs without a successful query | Never arms a new dispatch; same fallback as an Octopus failure, with `octopus_error` set. |
| Arm start out of slot order | `hold`: nothing written, `action: skipped`. |
| `GUARD_RESTORE_START` out of slot order | Run stops. Nothing changed. |
| Dispatch later today or tomorrow (beyond `GUARD_LEAD_IN_MIN`) | Not armed yet, because slots have no date. |
| Car unplugged (plug gate on) | Restore settings written, not arm ones. |
| **Plug state can't be read** (timeout, 401, HA error, `unavailable`/`unknown`, no state) | **Restore** instead of arming, `plug_error` set, stored dispatch start cleared, so an already-armed slot is put back. |
| A Control call fails partway through the guard's three commands | Guard run stops, and the marker isn't updated, so the next run tries again. |
| Read-back mismatch | `ok: false`, guard `action: write_failed`, retried next run. |
| `crypto` blocked or Sunsynk login fails | Control stops before any write. |
| Invalid serial, command or field | Control stops before login. |

## Alerting on Octopus failures

`Octopus Dispatches` is set to continue on error so that the fallback restore can run. The guard execution itself must **succeed** during an outage: n8n saves workflow static data (`last`, `arm`, `committed_arm`, `octopus_failures`) only "when the workflow execution succeeds" ([n8n docs](https://docs.n8n.io/build/code-in-n8n/cookbook/built-in-methods-and-variables-examples/getworkflowstaticdata/)). If the run failed, the next run would forget a restore it had just verified and rewrite the inverter every 10 minutes. So the guard doesn't use n8n's error workflow for outages. Instead, two nodes run after `Gate And Send` (so any fallback restore has already been sent):

1. `Octopus Alert` (Code, never throws, set to continue on error). When `octopus_error` is set **and** `GUARD_ALERT_WORKFLOW_ID` is set, it outputs one item:
   `{ alert_workflow_id, source: "io-ev-guard", kind: "octopus_unavailable", message, octopus_failures, octopus_error, mode, action, reason }`
   where `message` is `Octopus unavailable (N consecutive runs): <error> Fallback: mode=<arm|restore>, action=<written|no_change|…>.` Otherwise it outputs nothing and the branch stops.
2. `Send Alert` (Execute Sub-workflow) calls that workflow by ID with **Wait for Sub-Workflow Completion off** and **On Error: Continue**. With waiting off, n8n starts the sub-workflow and returns the input items straight away, so the sub-workflow's own result can't fail the guard. If the call itself fails (wrong ID, workflow missing or not callable), Continue passes an `{ error }` item on instead of stopping the workflow ([Execute Sub-workflow](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/), [node settings: On Error](https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes/)).

Setup:

- Create an alert workflow that starts with **When Executed by Another Workflow** (input data mode **Accept all data**). In it, deliver `message` however you like: email, Home Assistant notify, ntfy, a webhook. Use `octopus_failures` to alert only after, say, 3 consecutive failures, since the guard polls every 10 minutes and a sustained outage sends an item every run.
- In that workflow's settings, allow the guard to call it (**This workflow can be called by**), and publish it.
- Set `GUARD_ALERT_WORKFLOW_ID` to its ID (the part after `/workflow/` in its URL).
- Blank (the default) means no alert. The failure is still visible in each execution's output as `octopus_error` and `octopus_failures`.
- N counts consecutive failed Octopus queries and resets on the next successful query.
- A guard error workflow (workflow settings → Error workflow) is still worth setting for real failures, such as a bad config. Those executions stop before anything is written.
- If the alert says `mode=restore` and `action=write_failed` (or Control is off), the slot wasn't restored: follow the manual recovery below.

## Emergency manual recovery

Disabling the automation is not the same as restoring the inverter. Anything already written stays on the inverter. Do it in this order, so the guard (which polls every 10 minutes) can't re-arm the slot after you've fixed it:

1. **Disable future automatic writes first:** deactivate Sunsynk Control, or set `SUNSYNK_WRITES_ENABLED=false` and restart n8n. This does **not** restore the timer. An armed slot stays armed.
2. **Restore the slot by hand in the Sunsynk app:** open the system timer, find slot `GUARD_SLOT` (and `SELL_SLOT` if you use Sell), and check its start time (`sellTimeN`), grid charge (`timeNOn`) and battery target (`capN`). An armed guard slot shows grid charge on, a target of `GUARD_CAP_SOC` (default 100) and a start moved to the dispatch time. Put back the settings you intend, normally your `GUARD_RESTORE_START`, `GUARD_RESTORE_GRID_CHARGE` and `GUARD_RESTORE_CAP_SOC` values. Leave protected slots alone.
3. **Verify:** save, re-open the timer and confirm the values took.

## What it doesn't protect against

- During an Octopus outage the guard can't see new, changed or cancelled dispatches. A verified arm stays until its *stored* end even if Octopus cancelled the dispatch meanwhile; nothing new is armed until Octopus answers.
- The fallback restore itself needs Sunsynk Control and writes to be working. If they aren't, the slot stays as it is: use the [manual recovery](#emergency-manual-recovery).
- Disabling writes doesn't undo an armed slot. See [manual recovery](#emergency-manual-recovery).

- Evening Sell doesn't check slot order or protected slots, and it doesn't fail on `ok: false`.
- If you change the inverter's timer by hand, `GUARD_SLOT_PREV_START` / `GUARD_SLOT_NEXT_START` can go out of date.
- The guard's stop marker records what it last wrote, not what's on the inverter now. A manual change to the guard slot isn't noticed until the wanted settings change.
- The Sunsynk API is unofficial and can change. See [../DISCLAIMER.md](../DISCLAIMER.md).
