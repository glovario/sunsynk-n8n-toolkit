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
| Octopus token, device or dispatch query fails (network, GraphQL `errors`, no `data`, missing field) after retries | Run stops: "… Nothing was changed." Never treated as "no dispatches", so no restore. "Nothing was changed" is true only for *this run*: see the next row. |
| **Octopus fails after an earlier run armed the slot** (known limitation of the current code) | `Octopus Dispatches` throws, so `Plan` and `Gate And Send` never run and **no restore is sent**. The slot stays armed (grid charge on, `capN = GUARD_CAP_SOC`) past the end of the dispatch, and the inverter can import at peak rates until Octopus answers again. Monitor failed executions and, if the API stays down, check and restore the slot by hand ([manual recovery](#emergency-manual-recovery)). |
| No EV or charger on the account | Run stops. Nothing changed. |
| A dispatch with a bad start/end | Run stops. Nothing changed. |
| Plan runs without a successful query | Plan refuses: "Octopus query did not succeed; refusing to plan." |
| Arm start out of slot order | `hold`: nothing written, `action: skipped`. |
| `GUARD_RESTORE_START` out of slot order | Run stops. Nothing changed. |
| Dispatch later today or tomorrow (beyond `GUARD_LEAD_IN_MIN`) | Not armed yet, because slots have no date. |
| Car unplugged (plug gate on) | Restore settings written, not arm ones. |
| **Plug state can't be read** (timeout, 401, HA error, `unavailable`/`unknown`, no state) | **Restore** instead of arming, `plug_error` set, stored dispatch start cleared, so an already-armed slot is put back. |
| A Control call fails partway through the guard's three commands | Guard run stops, and the marker isn't updated, so the next run tries again. |
| Read-back mismatch | `ok: false`, guard `action: write_failed`, retried next run. |
| `crypto` blocked or Sunsynk login fails | Control stops before any write. |
| Invalid serial, command or field | Control stops before login. |

## Emergency manual recovery

Disabling the automation is not the same as restoring the inverter. Anything already written stays on the inverter. Do it in this order, so the guard (which polls every 10 minutes) can't re-arm the slot after you've fixed it:

1. **Disable future automatic writes first:** deactivate Sunsynk Control, or set `SUNSYNK_WRITES_ENABLED=false` and restart n8n. This does **not** restore the timer. An armed slot stays armed.
2. **Restore the slot by hand in the Sunsynk app:** open the system timer, find slot `GUARD_SLOT` (and `SELL_SLOT` if you use Sell), and check its start time (`sellTimeN`), grid charge (`timeNOn`) and battery target (`capN`). An armed guard slot shows grid charge on, a target of `GUARD_CAP_SOC` (default 100) and a start moved to the dispatch time. Put back the settings you intend, normally your `GUARD_RESTORE_START`, `GUARD_RESTORE_GRID_CHARGE` and `GUARD_RESTORE_CAP_SOC` values. Leave protected slots alone.
3. **Verify:** save, re-open the timer and confirm the values took.

## What it doesn't protect against

- **Known limitation of the current code:** an Octopus outage after an earlier arm leaves the slot armed past the dispatch, because no restore runs while `Octopus Dispatches` is failing. See the fail-closed table and [manual recovery](#emergency-manual-recovery).
- Disabling writes doesn't undo an armed slot. See [manual recovery](#emergency-manual-recovery).
- `GUARD_SLOT=1` isn't supported (see [configuration.md](configuration.md#known-issues)).

- Evening Sell doesn't check slot order or protected slots, and it doesn't fail on `ok: false`.
- If you change the inverter's timer by hand, `GUARD_SLOT_PREV_START` / `GUARD_SLOT_NEXT_START` can go out of date.
- The guard's stop marker records what it last wrote, not what's on the inverter now. A manual change to the guard slot isn't noticed until the wanted settings change.
- The Sunsynk API is unofficial and can change. See [../DISCLAIMER.md](../DISCLAIMER.md).
