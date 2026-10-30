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

`Octopus Dispatches` is set to continue on error so that the fallback restore can run. To keep outages visible, the last node, `Octopus Alert`, runs **after** `Gate And Send` (so any fallback restore has already been sent) and, when `octopus_error` is set, fails the execution with:

`Octopus unavailable (N consecutive runs): <error>. Fallback: mode=<arm|restore>, action=<written|no_change|…>.`

- N counts consecutive failed Octopus queries (`octopus_failures` in static data) and resets on the next successful query.
- Set an n8n error workflow on the guard (workflow settings → Error workflow) to be notified. The guard polls every 10 minutes, so a sustained outage fails every run; use N in your error workflow if you only want to alert after, say, 3 consecutive failures. How you deliver the alert (email, Home Assistant, etc.) is **TBD** for your setup.
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
