# Configuration guide

Every setting the toolkit reads, where it lives, and how to go from dry run to live. Facts here come from the workflow code (`workflows/*.json`), [`config/schema.json`](../config/schema.json) and [`config/example.env`](../config/example.env). Anything not confirmed is marked **TBD**.

## Where settings live

- **What goes where.** User-specific config and secrets (logins, inverter serial, device IDs, URLs, tokens, switches) go in **environment variables**. Workflow defaults are **embedded in the Code nodes** (the `env.X || default` fallbacks), so an unset variable uses the default listed below.
- **Environment variables.**
  - Every setting is read from n8n **environment variables** through `$env` in the Code nodes.
  - The workflow JSON holds no settings and no secrets.
  - n8n can't read them unless `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
- **n8n Variables** (the `$vars` feature) are **not used**. Values set there are ignored.
- **The Home Assistant token** is also read from an environment variable, `HA_TOKEN`. Nothing is read from Home Assistant's `secrets.yaml`. The guard only calls the URL you give it, with `Authorization: Bearer <HA_TOKEN>`.
- **The one n8n credential** is the Header Auth credential on the Sunsynk Control Webhook node. Its name and value must match `SUNSYNK_CONTROL_HEADER_NAME` / `SUNSYNK_CONTROL_HEADER_VALUE`, which the guard and Sell send as the request header.

### Setting them in n8n

1. Copy `config/example.env` to `.env`. Never commit it.
2. Pass it to the n8n process, for example `docker run --env-file .env …`, or `env_file: .env` in docker compose. The right method depends on how you run n8n. `--env-file` takes everything after `=` literally, so keep comments on their own lines: `KEY=value # note` sets the value to `value # note`.
3. If you use external task runners (`N8N_RUNNERS_MODE=external`), the Code nodes run on the runner, so the runner needs the variables too. For the `n8nio/runners` image, also allow them in `n8n-task-runners.json`. The exact allow-list format is **TBD**: check your runner image's docs.
4. Restart n8n (and the runner). Each workflow reads the settings again on every run.

### How switches are read

The switches are text, and each is parsed slightly differently:

| Setting | Counts as on when… |
|---|---|
| `GUARD_DRY_RUN`, `SELL_DRY_RUN` | anything except `false` (any case). Unset means dry run. |
| `SUNSYNK_WRITES_ENABLED` | `true` (any case). |
| `SELL_ENABLED`, `SELL_WRITE_ENABLE_FLAG`, `GUARD_RESTORE_GRID_CHARGE` | exactly `true`. |

## Every setting

Columns:
- **Used by:** C = Sunsynk Control, G = IO EV Guard, S = Evening Sell, n8n = read by n8n itself.
- **Live?:** whether the setting must be set (or changed from its default) before real writes.

| Name | Used by | Meaning | Type | Allowed | Default | Live? | Example |
|---|---|---|---|---|---|---|---|
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | n8n | Lets Code nodes read env vars | boolean | must be `false` | `false` | yes | `false` |
| `NODE_FUNCTION_ALLOW_BUILTIN` | n8n (C needs it) | Allows Node's `crypto` in Code nodes for Sunsynk Login | string list | must include `crypto` | `crypto` | yes | `crypto` |
| `SUNSYNK_USERNAME` | C | Sunsynk Connect login (secret) | string | no MFA | none | yes | `you@example.com` |
| `SUNSYNK_PASSWORD` | C | Sunsynk Connect password (secret) | string | | none | yes | `change-me` |
| `SUNSYNK_API_HOST` | C | Cloud API host | enum | `api.sunsynk.net`, `pv.inteless.com` | `api.sunsynk.net` | no | `api.sunsynk.net` |
| `SUNSYNK_INVERTER_SN` | C, G, S | Inverter serial | string | 6–12 digits | none | yes | `0000000000` |
| `SUNSYNK_WRITES_ENABLED` | C | Master write switch | boolean | | `false` | yes (`true`) | `true` |
| `SUNSYNK_CONTROL_URL` | G, S | Control webhook URL | URI | | `http://127.0.0.1:5678/webhook/sunsynk-control` | no | default |
| `SUNSYNK_CONTROL_HEADER_NAME` | G, S | Header name for the webhook key | string | | `X-Control-Key` | no | `X-Control-Key` |
| `SUNSYNK_CONTROL_HEADER_VALUE` | G, S | Webhook key (secret) | string | long random | empty | yes | `change-me-long-random-string` |
| `OCTOPUS_API_KEY` | G | Octopus API key (secret) | string | | none | yes | `sk_live_change-me` |
| `OCTOPUS_ACCOUNT` | G | Octopus account number | string | `A-` + hex (schema) | none | yes | `A-00000000` |
| `OCTOPUS_EV_DEVICE_ID` | G | EV or charger device ID | string | | blank (first EV/charger) | no | blank |
| `OCTOPUS_RETRIES` | G | Tries per Octopus query | integer | 1–5 (schema) | `3` | no | `3` |
| `OCTOPUS_RETRY_DELAY_MS` | G | Base delay between tries (multiplied by the try number) | integer | ≥ 0 | `2000` | no | `2000` |
| `GUARD_DRY_RUN` | G | Guard sends dry-run requests only | boolean | | `true` | yes (`false`) | `false` |
| `GUARD_TIMEZONE` | G | Zone for the off-peak window and slot times | IANA zone | | `Europe/London` | no | `Europe/London` |
| `GUARD_SLOT` | G, S | The one timer slot the guard writes | integer | 1–6 | `5` | no | `5` |
| `GUARD_PROTECTED_SLOTS` | G | Slots the IO EV Guard must never modify | comma list | must not include `GUARD_SLOT` | `1,2,3,4,6` | no | `1,2,3,4,6` |
| `GUARD_SLOT_PREV_START` | G | Start time of slot `GUARD_SLOT - 1` (slot 6, from the day before, if `GUARD_SLOT=1`) | `HH:MM` | | none | **yes** | `05:30` |
| `GUARD_SLOT_NEXT_START` | G | Start time of slot `GUARD_SLOT + 1` (slot 1, usually `00:00`, if `GUARD_SLOT=6`). With Sell enabled in that slot, must equal `SELL_START` | `HH:MM` | | none | **yes** | `23:30` |
| `GUARD_CAP_SOC` | G | Battery target while armed | integer % | 10–100 | `100` | no | `100` |
| `GUARD_RESTORE_START` | G | Slot start time put back afterwards | `HH:MM` | must sit between the neighbours, not equal either; with Sell enabled, not equal `SELL_START` | `16:00` | no | `16:00` |
| `GUARD_RESTORE_CAP_SOC` | G | Battery target put back afterwards | integer % | 10–100 | `50` | no | `50` |
| `GUARD_RESTORE_GRID_CHARGE` | G | Grid charge state put back afterwards | boolean | | `false` | no | `false` |
| `GUARD_OFFPEAK_START` | G | Start of your normal cheap window | `HH:MM` | | `23:30` | no | `23:30` |
| `GUARD_OFFPEAK_END` | G | End of your normal cheap window | `HH:MM` | | `05:30` | no | `05:30` |
| `GUARD_LEAD_IN_MIN` | G | Arm at most this many minutes before an extra dispatch | integer | 0–120 | `20` | no | `20` |
| `GUARD_ALERT_WORKFLOW_ID` | G | n8n workflow ID to call when an Octopus query fails (trigger: When Executed by Another Workflow, Accept all data). Blank = no alert | string | | blank | no | `aBcD1234eFgH5678` |
| `GUARD_PLUG_STATE_URL` | G | Home Assistant state URL for "car plugged in". Blank turns the gate off | string | | blank | no | `http://homeassistant.local:8123/api/states/binary_sensor.car_plugged_in` |
| `GUARD_PLUG_ON_STATES` | G | States that mean plugged in. Entries and the Home Assistant state are trimmed and lower-cased, so `on, plugged_in` works | comma list | | `on,plugged_in,true` | no | `on,plugged_in,true` |
| `HA_TOKEN` | G | Home Assistant long-lived token (secret) | string | | empty | only with the plug gate | `change-me` |
| `SELL_ENABLED` | S | Turns Sell on | boolean | | `false` | for Sell (`true`) | `true` |
| `SELL_DRY_RUN` | S | Sell sends dry-run requests only | boolean | | `true` | for Sell (`false`) | `false` |
| `SELL_SLOT` | S | Timer slot Sell writes | integer | 1–6, not `GUARD_SLOT` | `6` | no | `6` |
| `SELL_START` | S | Sell slot start time | `HH:MM` | | `18:00` | no | `18:00` |
| `SELL_FLOOR_SOC` | S | Battery floor for the Sell slot (written as `capN`) | integer % | 20–100 | `50` | no | `50` |
| `SELL_WRITE_ENABLE_FLAG` | S | Also write `sellTimeNEn` | boolean | | `false` | no | `false` |

`config/schema.json` lists only `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD` and `SUNSYNK_INVERTER_SN` as required. The table marks what you actually need in order to run the guard live. `example.env` and `schema.json` list the same settings; `node tests/run.js` fails if they drift apart or if any value in `example.env` breaks the schema.

## Settings by group

### Credentials
- `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD`
  - Used only by Sunsynk Login, in Control.
  - The password is RSA-encrypted with the key Sunsynk publishes, then sent.
  - Accounts with MFA can't log in.
- `OCTOPUS_API_KEY`: swapped for a Kraken token on each guard run.
- `SUNSYNK_CONTROL_HEADER_VALUE`: the shared key between the callers and Control. It must match the Webhook node's Header Auth credential.
- `HA_TOKEN`: sent as a Bearer token to `GUARD_PLUG_STATE_URL`.

### Sunsynk inverter
- `SUNSYNK_INVERTER_SN`
  - Control checks it on every request (6–12 digits).
  - The guard's Config checks it before anything runs.
  - No plant ID is used anywhere.
- `SUNSYNK_API_HOST`: use `pv.inteless.com` for Deye/Inteless accounts. That host is untested.

### Timer slots
- `GUARD_SLOT` is the only slot the guard writes. `GUARD_PROTECTED_SLOTS` are the slots the IO EV Guard must never modify. Config stops if the guard slot is in the protected list.
- `GUARD_PROTECTED_SLOTS` binds only the guard. Evening Sell and Sunsynk Control have separate permissions: Sell writes `SELL_SLOT` and checks only that it differs from `GUARD_SLOT`; Control applies its own per-command field allow-list.
- The default Sell slot (`SELL_SLOT=6`) is on the guard's default protected list (`1,2,3,4,6`), so the guard never touches the Sell slot.
- The **order rule:**
  - A slot's start must fall strictly after the previous slot's start and strictly before the next one's (`GUARD_SLOT_PREV_START < start < GUARD_SLOT_NEXT_START`).
  - Only slot 1 and slot 6 may wrap past midnight. For slot 1 the previous slot is slot 6 from the day before (e.g. prev 23:30, next 05:30 allows 23:40 or 00:10). For slot 6 the next slot is slot 1 the day after (usually `00:00`). For slots 2–5, `GUARD_SLOT_PREV_START` must be earlier than `GUARD_SLOT_NEXT_START`.
  - When arming, the guard checks the arm start time against this rule. If the time falls outside it, the guard goes to `hold` and writes nothing.
  - Config also checks `GUARD_RESTORE_START` against the neighbours and rejects duplicate starts (prev = next, or restore = a neighbour).
- Leaving the neighbours blank skips the order check, which is allowed only in dry run. The guard reports "slot order not checked" in `reason`.
- Keep the neighbours in step with your inverter. If you change slot 4 or 6 in the app, update them.

### Octopus and dispatches
- **Device:** `OCTOPUS_EV_DEVICE_ID` picks the device. If it's blank, the guard uses the first `ELECTRIC_VEHICLES` or `CHARGE_POINTS` device on `OCTOPUS_ACCOUNT`.
- **What counts as extra:** `GUARD_OFFPEAK_START` / `GUARD_OFFPEAK_END` define the normal window, built from local dates in `GUARD_TIMEZONE`. Only the parts of a dispatch outside it count as extra.
- **`GUARD_LEAD_IN_MIN`:**
  - The guard arms only for an extra dispatch that is running now or starts within this many minutes.
  - Timer slots have no date, so arming earlier would also affect today's matching time.
  - With the default 20 and the 10-minute schedule, a dispatch starting at 14:10 is first armed on the 13:50 run (20 minutes before).
- **Retries:** `OCTOPUS_RETRIES` / `OCTOPUS_RETRY_DELAY_MS`. If every try fails, the guard falls back to stored state (keeps a verified arm until its stored end, otherwise restores) and the execution still succeeds (so the state is saved), calling your alert workflow if `GUARD_ALERT_WORKFLOW_ID` is set. See [safety.md](safety.md#alerting-on-octopus-failures).

### Evening Sell
- On each run, Sell sets slot `SELL_SLOT` to start at `SELL_START`, turns grid charge off and sets `capN` to `SELL_FLOOR_SOC`. With `SELL_WRITE_ENABLE_FLAG=true`, it also sets `sellTimeNEn` (to `1` if `SELL_ENABLED`, otherwise `0`).
- It runs daily at 17:55, so set `SELL_START` after that.
- Sell doesn't check the slot order or `GUARD_PROTECTED_SLOTS`. Choose `SELL_SLOT` and `SELL_START` to fit your timer yourself. If `SELL_SLOT` is `GUARD_SLOT + 1`, set `GUARD_SLOT_NEXT_START` to `SELL_START` (or `GUARD_SLOT_PREV_START` if it's `GUARD_SLOT - 1`).
- With `SELL_ENABLED=true`, the guard's Config enforces this and rejects `GUARD_RESTORE_START = SELL_START`. With Sell disabled, the `SELL_*` values (e.g. the ones in `example.env`) don't constrain the guard.

### Battery targets (SOC)
- `GUARD_CAP_SOC` (10–100): the target while an extra dispatch runs. 100 lets the battery charge fully at the cheap rate.
- `GUARD_RESTORE_CAP_SOC` (10–100): put back afterwards.
- `SELL_FLOOR_SOC` (20–100): the Sell slot's `capN`, which is how far down the battery is meant to export. The actual inverter behaviour is **TBD** (see [overview.md](overview.md)).
- Control itself refuses any `capN` outside 10–100.

### Optional Home Assistant plug gate
- `GUARD_PLUG_STATE_URL` set: before writing, the guard reads `state` from that URL.
  - **A state in `GUARD_PLUG_ON_STATES`:** the guard can arm.
  - **Any other readable state:** counts as unplugged, so the guard writes the restore settings.
  - **Unreadable** (request error, timeout, 401, `unavailable`, `unknown`, or no `state` text): the guard restores instead of arming, reports `plug_error`, and clears the stored dispatch start.
- Blank: there's no gate, and the guard arms on Octopus data alone.

### Write and dry-run switches
- **Control:** writes only when `SUNSYNK_WRITES_ENABLED=true` **and** the request has `"dry_run": false`.
- **Guard:** sends `dry_run: false` only when `GUARD_DRY_RUN=false`.
- **Sell:** sends `dry_run: false` only when `SELL_DRY_RUN=false` **and** `SELL_ENABLED=true`.
- `SELL_WRITE_ENABLE_FLAG` controls whether `sellTimeNEn` is written at all. Leave it `false` unless you've tested your firmware (see [timer-quirks.md](timer-quirks.md)).

## Worked example

A typical setup uses slot 5 for the guard, slot 6 for Sell from 18:00, and the default IO window. It assumes slot 4 starts at 05:30. Because Sell writes slot 6's start, `GUARD_SLOT_NEXT_START` must equal `SELL_START`. These are placeholders only:

```env
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
NODE_FUNCTION_ALLOW_BUILTIN=crypto

SUNSYNK_USERNAME=you@example.com
SUNSYNK_PASSWORD=change-me
SUNSYNK_API_HOST=api.sunsynk.net
SUNSYNK_INVERTER_SN=0000000000

SUNSYNK_CONTROL_URL=http://127.0.0.1:5678/webhook/sunsynk-control
SUNSYNK_CONTROL_HEADER_NAME=X-Control-Key
SUNSYNK_CONTROL_HEADER_VALUE=change-me-long-random-string

OCTOPUS_API_KEY=sk_live_change-me
OCTOPUS_ACCOUNT=A-00000000
OCTOPUS_EV_DEVICE_ID=

GUARD_TIMEZONE=Europe/London
GUARD_SLOT=5
GUARD_PROTECTED_SLOTS=1,2,3,4,6
GUARD_SLOT_PREV_START=05:30
GUARD_SLOT_NEXT_START=18:00
GUARD_CAP_SOC=100
GUARD_RESTORE_START=16:00
GUARD_RESTORE_CAP_SOC=50
GUARD_RESTORE_GRID_CHARGE=false
GUARD_OFFPEAK_START=23:30
GUARD_OFFPEAK_END=05:30
GUARD_LEAD_IN_MIN=20

GUARD_PLUG_STATE_URL=http://homeassistant.local:8123/api/states/binary_sensor.car_plugged_in
GUARD_PLUG_ON_STATES=on,plugged_in,true
HA_TOKEN=change-me

# Still in dry run. See the switch order below.
SUNSYNK_WRITES_ENABLED=false
GUARD_DRY_RUN=true
SELL_ENABLED=false
SELL_DRY_RUN=true
SELL_WRITE_ENABLE_FLAG=false
SELL_SLOT=6
SELL_START=18:00
SELL_FLOOR_SOC=50
```

Here `GUARD_RESTORE_START=16:00` sits between 05:30 and 18:00, so it passes the order check. 16:00 is also the default. An extra dispatch after 18:00 would also go to `hold` here, because slot 5 can't move past slot 6.

The best timer layout for your house is **TBD** and depends on your inverter and tariff.

## Going from dry run to live

Before you switch on writes, read [safety.md: Emergency manual recovery](safety.md#emergency-manual-recovery). Turning writes off later does not undo a slot the guard has already armed: to recover, disable writes first, then restore the slot by hand and verify.

1. Run everything in dry run for a few days. Check that the guard's `mode`, `extra_start`/`extra_end` and `params` look right, and that Control returns `would_write`.
2. Set `GUARD_SLOT_PREV_START` and `GUARD_SLOT_NEXT_START` to match the inverter. Check that no run reports `hold` or "slot order not checked" unexpectedly.
3. Set `SUNSYNK_WRITES_ENABLED=true`. With the guard still in dry run, nothing is written yet.
4. Set `GUARD_DRY_RUN=false` and restart. Check the next `written` action: every Control reply should be `ok: true` with no `mismatches`, and the slot should look right in the Sunsynk app.
5. Only then, if you want Sell, set `SELL_ENABLED=true` and `SELL_DRY_RUN=false`. Check your DNO export limit and tariff first.

To go back to dry run at any time, set `SUNSYNK_WRITES_ENABLED=false`. That stops every write from both workflows.

## What the setting checks report

**Guard: Config node.** It collects every problem and stops with one error, `Config: <problem>; <problem>; …`. Nothing is sent. The checks:
- `GUARD_SLOT must be 1-6`
- `GUARD_SLOT is listed in GUARD_PROTECTED_SLOTS`
- `GUARD_LEAD_IN_MIN must be 0-120`
- `slot_prev_start must be HH:MM` / `slot_next_start must be HH:MM`
- `Set GUARD_SLOT_PREV_START and GUARD_SLOT_NEXT_START before turning dry run off`
- `restore_start` / `offpeak_start` / `offpeak_end must be HH:MM`
- `guard_cap_soc` / `restore_cap_soc must be 10-100`
- `Set OCTOPUS_API_KEY and OCTOPUS_ACCOUNT env vars`
- `Set SUNSYNK_INVERTER_SN`
- `GUARD_SLOT_PREV_START and GUARD_SLOT_NEXT_START are a duplicate slot start (…)`
- `GUARD_RESTORE_START … is a duplicate slot start of a neighbour slot`
- `GUARD_RESTORE_START … is out of slot order (must be after … and before …)`
- `GUARD_SLOT_PREV_START … / GUARD_SLOT_NEXT_START … are out of slot order (only slot 1 or 6 may cross midnight)`
- With `SELL_ENABLED=true` only: `GUARD_RESTORE_START … is the same as SELL_START (duplicate slot start)`, and `Sell is slot N, the next slot: GUARD_SLOT_NEXT_START (…) must equal SELL_START (…)` (or the previous-slot equivalent)

**Guard: Plan node.**
- `GUARD_RESTORE_START is out of slot order. Nothing was changed.` (normally caught by Config first)
- An arm time out of order gives `mode: hold` with a `reason` instead of an error.

**Sell.** It stops at the first problem:
- `SELL_SLOT must be 1-6`
- `SELL_SLOT must differ from GUARD_SLOT`
- `SELL_START must be HH:MM`
- `SELL_FLOOR_SOC must be 20-100`

**Control.** It stops at the first problem:
- `Missing or invalid inverter serial (sn)`
- `Unknown command: …`
- `Field … not allowed for …`
- `sellTimeN must be HH:MM`
- `capN must be 10-100`
- `Set SUNSYNK_USERNAME and SUNSYNK_PASSWORD as n8n environment variables`
- the `crypto` message (see [troubleshooting.md](troubleshooting.md))

**Not checked** by any workflow:
- `OCTOPUS_ACCOUNT`'s format
- `OCTOPUS_RETRIES` limits
- `GUARD_TIMEZONE` validity
- `GUARD_PLUG_ON_STATES` contents

The schema describes them, but nothing enforces it at run time.

## Known issues

None open in the guard's slot handling. Earlier issues (slot 1 unsupported, the 18:00 restore/Sell default clash, and an armed slot persisting through an Octopus outage) are fixed; see [safety.md](safety.md#fail-closed-paths).
