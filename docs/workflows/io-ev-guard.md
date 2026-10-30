# IO EV Guard (`workflows/io-ev-guard.json`)

The guard holds the house battery during Intelligent Octopus extra dispatches, using one timer slot. All settings are in [../configuration.md](../configuration.md).

## Nodes

```
Every 10 minutes → Config → Octopus Dispatches → Plan → Gate And Send → Octopus Alert → Send Alert
```

### 1. Every 10 minutes (schedule trigger)
Cron `*/10 * * * *`.

### 2. Config (Code)
- Reads the `GUARD_*`, `OCTOPUS_*`, `SUNSYNK_CONTROL_URL` and `SUNSYNK_INVERTER_SN` env vars, applying the defaults.
- Validates them all, then stops with a single `Config: …` error listing every problem. See [../configuration.md#what-the-setting-checks-report](../configuration.md#what-the-setting-checks-report).
- Output: the resolved config object.

### 3. Octopus Dispatches (Code)
1. Gets a Kraken token with `obtainKrakenToken(APIKey)`.
2. If `OCTOPUS_EV_DEVICE_ID` is blank, lists `devices(accountNumber)` and picks the first device of type `ELECTRIC_VEHICLES` or `CHARGE_POINTS`. If there's none, it stops: "No EV or charger found…".
3. Reads `flexPlannedDispatches(deviceId)` (`start`, `end`, `type`).

Each query is tried up to `OCTOPUS_RETRIES` times, with a delay of `OCTOPUS_RETRY_DELAY_MS × try number`.
- A query fails if the reply is empty, has GraphQL `errors`, has no `data`, or is missing the expected field.
- After the last try, the node throws `Octopus <query> failed after N tries: …`. A dispatch with an unparseable start or end also throws.
- The node is set to **continue on error** (`onError: continueRegularOutput`), so n8n passes `{ error }` to Plan instead of stopping.

Output: `{ query_ok: true, device_found: true, planned }`.

### 4. Plan (Code)
- **Octopus failed** (no `query_ok: true` + `planned` list): `octopus_error` is set and `octopus_failures` (consecutive) is incremented; it resets on success. Plan never arms a new dispatch. It returns `mode: arm` with the stored start only if `committed_arm` (written by Gate And Send after a verified arm) matches the stored `arm` and the stored end hasn't passed; otherwise `mode: restore` and the stored `arm` is cleared.
- **Extra segments:**
  - For each dispatch, it removes any overlap with the off-peak windows.
  - The windows are built from local calendar dates in `GUARD_TIMEZONE`, so 23:30 to 05:30 is right on either side of a clock change.
  - What's left are the extra segments, sorted by start.
- **Active** is the first extra segment that hasn't ended and starts within `GUARD_LEAD_IN_MIN`. **Upcoming** is the next one after it.
- **Decision:**
  - **active found:**
    - The arm start is fixed once per dispatch. On the first poll that sees the dispatch, it's the dispatch start, or now if the dispatch has already started.
    - The start is stored in workflow static data (`arm`), keyed by the dispatch start, with the dispatch end, and reused on later polls of the same dispatch.
    - It's checked against `GUARD_SLOT_PREV_START < start < GUARD_SLOT_NEXT_START` (wrapping past midnight for slot 1 and slot 6 only):
      - **out of order:** `mode: hold`, with no params and a `reason`.
      - **otherwise:** `mode: arm`. The params are `sellTimeN = start`, `timeNOn = '1'`, `timeNon = 'true'` and `capN = GUARD_CAP_SOC`. If the neighbours aren't set (dry run only), `reason` says "slot order not checked".
  - **no active dispatch:** `mode: restore` with the restore params (`GUARD_RESTORE_START`, `GUARD_RESTORE_GRID_CHARGE`, `GUARD_RESTORE_CAP_SOC`), and the stored `arm` is cleared.
- If the mode isn't `hold` and `GUARD_RESTORE_START` is out of slot order, the run stops with an error.
- **Output:**
  - `mode`, `reason`, `extra_count`
  - `extra_start`, `extra_end`, `next_extra_start` (ISO UTC)
  - `params`, `restore_params`, `dry_run`
  - `octopus_error`, `octopus_failures`, `arm_key`, `arm_end`

### 5. Gate And Send (Code)
1. **`hold`:** returns `action: skipped`, and nothing is sent.
2. **Plug gate**, when `GUARD_PLUG_STATE_URL` is set: GETs it with `Authorization: Bearer HA_TOKEN`.
   - **Readable state:** `plugged` is true if the state is in `GUARD_PLUG_ON_STATES` (lower case), otherwise false.
   - **Request error, `unavailable`, `unknown`, or no `state` text:** `plugged: null`, and `plug_error` says why.
3. **Mode changes:**
   - **arm + `plugged: false`:** restore instead.
   - **arm + `plugged: null`** (with the gate set): restore instead, the stored `arm` is cleared, and `reason` is `plug gate: … ; restoring instead of arming`.
4. **Stop marker:**
   - If `{mode, params}` matches the last *verified* write (`last` in static data), the node returns `action: no_change` and sends nothing.
5. **Send:** otherwise it sends three POSTs to `SUNSYNK_CONTROL_URL`, with the header `SUNSYNK_CONTROL_HEADER_NAME: SUNSYNK_CONTROL_HEADER_VALUE`. The commands are:
   - `set_sell_time`
   - `set_grid_charge`
   - `set_charge_cap`

   Each body is `{ command, params, sn, dry_run }`.
6. **Record:** the marker is saved only if dry run is off and every reply is `ok: true` and `dry_run: false`. Otherwise the marker is deleted, so the next run tries again.
   - `committed_arm` (dispatch key, start, end) is saved only for a verified `arm` write, kept on an `arm` `no_change` (and its `end` updated to the latest dispatch end when the key and start still match, so an extended dispatch stays trusted during an outage; an unverified arm is never promoted), and cleared on anything else (restore, dry run, failed write, plug refusal).

### 6. Octopus Alert (Code)
Runs after Gate And Send and never throws (n8n saves static data only on a successful execution). If `octopus_error` is set and `GUARD_ALERT_WORKFLOW_ID` is set, it outputs one alert item with `message` `Octopus unavailable (N consecutive runs): … Fallback: mode=…, action=….`; otherwise nothing, and the branch ends. Continues on error.

### 7. Send Alert (Execute Sub-workflow)
Calls the workflow in `GUARD_ALERT_WORKFLOW_ID` with the alert item. It doesn't wait for the sub-workflow and continues on error, so a broken alert workflow can't fail the guard. See [../safety.md](../safety.md#alerting-on-octopus-failures).

## Outputs and diagnostics

| `action` | Meaning |
|---|---|
| `written` | All three commands written and verified by read-back. |
| `no_change` | Same as the last verified write. Nothing sent. |
| `dry_run` | Sent as dry run. Control returned `would_write`. |
| `write_failed` | At least one reply wasn't a verified write (check `results[].mismatches`). Retried next run. |
| `skipped` | `hold` (slot order). Nothing sent. |

Other fields to read:
- `mode`: `arm`, `restore` or `hold`, after the plug gate.
- `reason`: the slot-order note, the hold reason, or the plug-gate reason.
- `plugged`: `true`, `false` or `null`.
- `plug_error`: why the plug state couldn't be read.
- `extra_start` / `extra_end` / `next_extra_start`.
- `results`: Control's replies.

The error messages are listed in [../troubleshooting.md](../troubleshooting.md).
