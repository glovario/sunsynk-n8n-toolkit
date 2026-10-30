# Troubleshooting

## "Sunsynk Login needs Node's built-in 'crypto' module…"
- n8n is blocking `crypto` in Code nodes. Set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, adding it to any existing comma-separated list.
- If you use external task runners, set it on the runner as well (for `n8nio/runners`, also in `n8n-task-runners.json`). Then restart.
- This happens even in dry run, because Login always runs.

## Login failures (MFA / 2FA)
- **"Sunsynk login failed (MFA accounts are not supported)"**
  - The cloud API login can't do MFA. Turn off MFA on the account, or create a separate account without it that has access to the inverter. How you share access depends on the Sunsynk app: **TBD**.
  - Also check `SUNSYNK_USERNAME` / `SUNSYNK_PASSWORD`, and `SUNSYNK_API_HOST` (Deye/Inteless use `pv.inteless.com`).
- **"Sunsynk public key request failed"**
  - The Sunsynk API didn't answer as expected. It may be down, or the API may have changed.
- **"Set SUNSYNK_USERNAME and SUNSYNK_PASSWORD…"**
  - The env vars aren't visible to Control. Check `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, and check the runner too.

## Octopus GraphQL errors
- **"Octopus token / devices / flexPlannedDispatches failed after 3 tries: …"**
  - The reason follows the colon:
    - `GraphQL error: …` (often a bad API key or account number)
    - `no data in response`
    - `expected field missing`
    - a network error
  - Nothing was changed *by this run*. The next scheduled run tries again.
  - **Known limitation of the current code:** if an earlier run armed the slot, it stays armed while these errors continue, even after the dispatch ends, because no restore runs. Set up monitoring of failed executions for the guard workflow (**TBD:** method depends on your n8n setup, e.g. an error workflow). If the errors persist past the dispatch, disable writes, then restore the slot by hand and verify: see [safety.md](safety.md#emergency-manual-recovery).
- **"No EV or charger found on the Octopus account"**
  - Set `OCTOPUS_EV_DEVICE_ID`, or check that the car or charger is linked to Intelligent Octopus on `OCTOPUS_ACCOUNT`.
- **"Octopus query did not succeed; refusing to plan"**
  - Plan was run without the Octopus step. This normally only happens if the workflow was edited.

## `plug_error` in the guard output
The guard couldn't read the plug sensor, so it restored the slot instead of arming. The messages:
- **`plug state request failed: …`**: the request failed. Check `GUARD_PLUG_STATE_URL` (it should be the full `/api/states/<entity_id>` URL), that n8n can reach Home Assistant, and that `HA_TOKEN` is a valid long-lived token (a 401 means it isn't).
- **`plug state unreadable: "unavailable"`** (or `"unknown"`, or `undefined`): Home Assistant answered, but the entity has no usable state. Check the entity in Home Assistant.

If the state is readable but the car is shown as unplugged when it's plugged in, add its state to `GUARD_PLUG_ON_STATES`.

## Timer-order holds
- **`mode: hold`, `action: skipped`, reason "arm start HH:MM is not between slot N-1 (…) and slot N+1 (…)"**
  - The extra dispatch's start doesn't fit between your neighbouring slots, so writing it would break the timer order.
  - Check that `GUARD_SLOT_PREV_START` / `GUARD_SLOT_NEXT_START` match the inverter. If dispatches regularly fall outside, consider a different `GUARD_SLOT` or moving the neighbouring slots.
  - The guard keeps holding for that dispatch, because the start is fixed per dispatch.
- **"GUARD_RESTORE_START is out of slot order"**
  - The restore time doesn't sit between the neighbours. Fix one of the three settings.
- **"Set GUARD_SLOT_PREV_START and GUARD_SLOT_NEXT_START before turning dry run off"**
  - Set both before going live.
- **`reason: slot order not checked`**
  - The neighbours are blank. That's allowed in dry run only.

## Mismatches after a write
- `ok: false` with `mismatches` means the read-back didn't match. See [timer-quirks.md](timer-quirks.md).
- The guard reports `write_failed` and tries again on the next run.

## Config errors
`Config: …` lists every setting that's wrong. See [configuration.md](configuration.md#what-the-setting-checks-report).
