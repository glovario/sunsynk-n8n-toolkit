# sunsynk-n8n-toolkit

Three [n8n](https://n8n.io) workflows that change the timer settings on a **Sunsynk** hybrid inverter through the Sunsynk Connect cloud API (`api.sunsynk.net`). They're for people on **Intelligent Octopus** with an EV, a Sunsynk battery and their own n8n instance, who want the battery to behave properly when Octopus hands the car extra cheap charging slots.

> ⚠️ Read [DISCLAIMER.md](DISCLAIMER.md) first. This uses an unofficial API to write settings to your inverter. **All writes are off by default.**

## The problem it solves

Intelligent Octopus charges the car overnight in the normal off-peak window (23:30–05:30 by default). It often adds "extra" dispatches outside that window too, for example in the afternoon. While one of those runs, the whole house is billed at the cheap rate.

The Sunsynk battery doesn't know that. If its timer says "discharge" at 14:00, it empties itself into the car, and you lose stored energy you could have bought cheaply anyway.

The **IO EV guard** spots extra dispatches and, for the length of one, turns on grid charge on a single timer slot. The battery then holds (or charges) at the cheap rate instead of discharging into the car. When the dispatch ends, the guard puts the slot back the way you configured it.

There's also an optional **evening Sell** workflow that sets one slot to export from a fixed time down to a battery floor.

## The workflows

### `workflows/sunsynk-control.json`: Sunsynk Control

The only workflow that talks to the inverter. The other two send it requests.

- **Trigger:** a webhook, `POST /webhook/sunsynk-control`, protected by an n8n Header Auth credential.
- **Input** (JSON body): `command`, `params`, optional `sn` (defaults to `SUNSYNK_INVERTER_SN`) and `dry_run`.
  - Commands, with the only fields each one accepts:
    - `set_sell_time`: `sellTime1`–`sellTime6`, `HH:MM`
    - `set_grid_charge`: `time1On`–`time6On` and `time1on`–`time6on`
    - `set_charge_cap`: `cap1`–`cap6`, 10–100
    - `set_sell_enable`: `sellTime1En`–`sellTime6En`
  - Anything else is rejected.
- **Steps:**
  1. **Validate Request:** checks the command, the fields and their ranges.
  2. **Sunsynk Login:** logs in with `SUNSYNK_USERNAME` / `SUNSYNK_PASSWORD` and caches the token until shortly before it expires.
  3. **Write And Verify:** sends the change, then reads the settings back and compares them field by field.
- **Output:**
  - Dry run: `{ ok: true, dry_run: true, would_write, command }`.
  - Real write: `{ ok, dry_run: false, command, set_reply_success, mismatches }`. `ok` is true only if the read-back matches.
- A real write happens only when `SUNSYNK_WRITES_ENABLED=true` **and** the request has `"dry_run": false`.

### `workflows/io-ev-guard.json`: IO EV Guard

- **Trigger:** a schedule, every 10 minutes (`*/10 * * * *`).
- **Inputs:**
  - The Octopus GraphQL API: a token from `OCTOPUS_API_KEY`, your EV or charger (`OCTOPUS_EV_DEVICE_ID`, or the first `ELECTRIC_VEHICLES` / `CHARGE_POINTS` device on `OCTOPUS_ACCOUNT`), then `flexPlannedDispatches`.
  - Optionally, a Home Assistant entity state for the car being plugged in.
- **Steps:**
  1. **Config:** reads and checks the settings, and stops with one error listing everything wrong.
  2. **Octopus Dispatches:** fetches the planned dispatches, retrying `OCTOPUS_RETRIES` times.
  3. **Plan:** cuts the normal off-peak window out of each dispatch. Whatever is left is "extra". The result is one of three modes:
     - `arm`: an extra dispatch is running now or starts within `GUARD_LEAD_IN_MIN`. Slot `GUARD_SLOT` gets that start time, grid charge on, and `GUARD_CAP_SOC`. The start time is fixed once per dispatch, so it doesn't creep forward on every poll.
     - `restore`: no extra dispatch is close. The slot gets `GUARD_RESTORE_START`, `GUARD_RESTORE_GRID_CHARGE` and `GUARD_RESTORE_CAP_SOC`.
     - `hold`: the arm start time would fall outside `GUARD_SLOT_PREV_START` … `GUARD_SLOT_NEXT_START`, so nothing is written.
  4. **Gate And Send:** checks the optional plug gate, then sends three commands to Sunsynk Control (`set_sell_time`, `set_grid_charge`, `set_charge_cap`). It only sends when the wanted settings differ from the last verified write.
- **Output** (per run): the plan (`mode`, `reason`, extra window, next extra start, params), `plugged`, `plug_error`, and an `action`:
  - `written`
  - `no_change`
  - `dry_run`
  - `write_failed`
  - `skipped` (hold)

### `workflows/evening-sell.json`: Sunsynk Evening Sell

- **Trigger:** a schedule, daily at 17:55 (`55 17 * * *`).
- **What it sends** to Sunsynk Control for slot `SELL_SLOT`:
  - start time `SELL_START`
  - `cap` = `SELL_FLOOR_SOC`
  - grid charge off
  - `sellTimeNEn` too, but only if `SELL_WRITE_ENABLE_FLAG=true`
- **Checks:** it refuses to run if `SELL_SLOT` equals `GUARD_SLOT`.
- **Output:** slot, start, floor, enabled, dry_run, and Control's replies.
- **Off by default.** It's a dry run unless `SELL_ENABLED=true` **and** `SELL_DRY_RUN=false`, on top of Control's own switch.

## How they fit together

```
 Schedule */10 min                      Schedule 17:55
        │                                     │
 ┌──────▼───────┐   Octopus GraphQL    ┌──────▼───────┐
 │ IO EV Guard  │◄──────────────────   │ Evening Sell │
 │              │◄── HA plug state     │  (optional)  │
 │              │    (optional)        │              │
 └──────┬───────┘                      └──────┬───────┘
        │  POST /webhook/sunsynk-control      │
        │  (header key, one call per command) │
        └────────────────┬────────────────────┘
                  ┌──────▼──────────┐
                  │ Sunsynk Control │── login, set, read back ──► api.sunsynk.net ──► inverter
                  └─────────────────┘
```

The guard and Sell each use their own timer slot (5 and 6 by default). Neither touches the others.

## Prerequisites

- **n8n:** a self-hosted instance whose Code nodes can read environment variables and make HTTP requests. Tested version: **TBD**.
- **`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`**, so the Code nodes can read the settings.
- **`NODE_FUNCTION_ALLOW_BUILTIN=crypto`** (add `crypto` to any existing comma-separated list). Sunsynk Login needs it, even in dry run, and stops with a clear error without it.
- **External task runners:** if you use them (`N8N_RUNNERS_MODE=external`), set both variables on the runner container too. For the `n8nio/runners` image, also allow them in its `n8n-task-runners.json`. Restart afterwards.
- **A Sunsynk Connect account without MFA,** plus your **inverter serial number** (Sunsynk app > Device > About). No plant ID is needed. Deye/Inteless accounts may work with `SUNSYNK_API_HOST=pv.inteless.com`, but that's untested.
- **An Octopus API key and account number** (`A-…`) on Intelligent Octopus, with your EV or charger linked.
- **Optional:** a Home Assistant entity that shows whether the car is plugged in, and a long-lived access token for it.

## Quick start

1. **Import** the three files from `workflows/` into n8n.
2. **Configure.** Copy `config/example.env` to `.env` (never commit it), fill it in, and load it into n8n's environment. Leave the safety switches as they are.
3. **Protect the webhook.** In **Sunsynk Control**, create a Header Auth credential whose name and value match `SUNSYNK_CONTROL_HEADER_NAME` / `SUNSYNK_CONTROL_HEADER_VALUE`, and attach it to the Webhook node.
4. **Activate** Sunsynk Control and the guard (and Sell if you want it).
5. **Dry run first.** Watch a few days of executions. Each guard run shows the mode, the extra window and the exact fields it *would* write.
6. **Set the slot neighbours.** Set `GUARD_SLOT_PREV_START` and `GUARD_SLOT_NEXT_START` to the start times of the slots either side of `GUARD_SLOT` on your inverter. The guard won't leave dry run without them.
7. **Turn writes on.** When you're happy, set `SUNSYNK_WRITES_ENABLED=true` and `GUARD_DRY_RUN=false`.
8. **Verify.** On the next real write, the guard's output should show `action: written`, and Control's replies should show `ok: true` with no `mismatches`. Check the slot in the Sunsynk app as well.
9. **Sell (optional).** To use it, also set `SELL_ENABLED=true` and `SELL_DRY_RUN=false`.

## Configuration

All settings are n8n environment variables. Every setting, with its type, default and allowed range, is in [`config/schema.json`](config/schema.json), and [`config/example.env`](config/example.env) is a starting file. These are the ones that matter most:

| Setting | Default | What it does |
|---|---|---|
| `SUNSYNK_WRITES_ENABLED` | `false` | Master switch in Control. Nothing is written while it's false. |
| `GUARD_DRY_RUN` | `true` | Guard sends dry-run requests only. |
| `SELL_ENABLED` / `SELL_DRY_RUN` | `false` / `true` | Both must change before Sell writes. |
| `SUNSYNK_INVERTER_SN` | none | Inverter serial, 6–12 digits. |
| `OCTOPUS_API_KEY`, `OCTOPUS_ACCOUNT` | none | Required for the guard. |
| `OCTOPUS_EV_DEVICE_ID` | blank | Blank uses the first EV or charger on the account. |
| `GUARD_SLOT` | `5` | The only timer slot the guard writes (1–6). |
| `GUARD_PROTECTED_SLOTS` | `1,2,3,4,6` | Slots never written. Must not include `GUARD_SLOT`. |
| `GUARD_SLOT_PREV_START`, `GUARD_SLOT_NEXT_START` | blank | Start times of the neighbouring slots (`00:00` for next if `GUARD_SLOT=6`). Required to leave dry run. |
| `GUARD_CAP_SOC` | `100` | Battery target while armed (10–100). |
| `GUARD_RESTORE_START`, `GUARD_RESTORE_CAP_SOC`, `GUARD_RESTORE_GRID_CHARGE` | `18:00`, `50`, `false` | What the slot is put back to. |
| `GUARD_OFFPEAK_START`, `GUARD_OFFPEAK_END` | `23:30`, `05:30` | Your normal cheap window. Dispatches inside it are ignored. |
| `GUARD_TIMEZONE` | `Europe/London` | Used for the off-peak window and slot times. |
| `GUARD_LEAD_IN_MIN` | `20` | Arm at most this many minutes before an extra dispatch (0–120). |
| `GUARD_PLUG_STATE_URL`, `GUARD_PLUG_ON_STATES`, `HA_TOKEN` | blank, `on,plugged_in,true`, blank | Optional plug gate, e.g. `http://homeassistant.local:8123/api/states/binary_sensor.car_plugged_in`. |
| `SELL_SLOT`, `SELL_START`, `SELL_FLOOR_SOC` | `6`, `18:00`, `50` | Sell slot, start time and floor (20–100). |
| `SELL_WRITE_ENABLE_FLAG` | `false` | Also write `sellTimeNEn`. See the timer quirks. |

## Safety model

**Writes are off by default.** Two independent switches must both be turned on:

- `SUNSYNK_WRITES_ENABLED` in Control
- `GUARD_DRY_RUN` (or `SELL_ENABLED` / `SELL_DRY_RUN`) in the calling workflow

**Narrow writes.**

- Control accepts timer fields only, with format and range checks.
- The guard writes one slot, never `GUARD_PROTECTED_SLOTS`, and never `sellTimeNEn`.

**Read-back verification.**

- Every real write is read back, because the API can reply "success" and change nothing.
- The guard records a write as done only when every command came back `ok: true` and not a dry run. A dry-run or failed reply is never cached, so the next run tries again.

**Fail-closed cases.**

- An Octopus API or GraphQL error, or missing data, stops the run after retries. It's never treated as "no dispatches", so a failed query doesn't trigger a restore.
- A bad config stops the run before anything is sent.
- An arm start time out of slot order means `hold`, and nothing is written.
- **Car unplugged** (plug gate on): the guard writes the restore settings instead of arming.
- **Plug state can't be read** (timeout, 401, Home Assistant error, `unavailable`/`unknown`, or an empty reply) while `GUARD_PLUG_STATE_URL` is set: the guard **restores** the slot rather than arming, and reports why in `plug_error`. It also forgets the stored dispatch start, so a slot that was already armed is put back.

**Timing and secrets.**

- A dispatch later today or tomorrow isn't armed early, because timer slots are daily times with no date.
- Off-peak boundaries use local calendar dates, so they're right on clock-change nights.
- Secrets live only in n8n environment variables or credentials, never in the workflow JSON.

## Timer quirks

The Sunsynk timer has some odd behaviour: two spellings of grid charge, "success" replies that change nothing, and a `sellTimeNEn` flag that some firmware ignores. See [docs/timer-quirks.md](docs/timer-quirks.md).

## Tested status

- **Offline tests: 22/22 pass.** Run `node tests/run.js`.
  - The tests run the real Code-node source from the workflow files with mocked n8n, Octopus, Sunsynk and Home Assistant replies. No network or inverter is needed.
  - They cover: arming then unplugging, dry run then writes on, Octopus errors and retries, dispatches later today and tomorrow, slot order, both UK clock changes, a stable start time across polls, plug-state failures, and blocked `crypto`.
- **Live integration test: pending.** The workflows haven't yet been run end to end against a real inverter. Not yet tested:
  - Deye/Inteless accounts
  - other firmware's `sellTimeNEn` behaviour
  - the Octopus `CHARGE_POINTS` device type
- **Tested on:**
  - Inverter model: **TBD**
  - Firmware: **TBD**
  - n8n version: **TBD**

## Troubleshooting

- **Login failed:** turn off MFA on the Sunsynk account, or use a separate account without MFA.
- **"needs Node's built-in 'crypto' module":** see Prerequisites.
- **"Octopus … failed after 3 tries":** an Octopus API or GraphQL error. Nothing was changed, and it tries again on the next run.
- **"Config: …":** the message lists every setting that's wrong.
- **`mismatches` after a write:** see the timer quirks.
- **`plug_error` in the guard output:** check `GUARD_PLUG_STATE_URL` and `HA_TOKEN`. The guard restores the slot until it can read the plug again.

## Limitations

- **Unofficial API:** it relies on the Sunsynk cloud API, which can change or block access without notice. It doesn't use a local or Modbus connection.
- **No MFA:** accounts with MFA can't log in.
- **Polling interval:** the guard polls every 10 minutes, so it can start up to 10 minutes late on a dispatch Octopus adds at short notice. Don't poll more often than every 5 minutes.
- **One slot at a time:** the guard uses one slot and handles one extra dispatch at a time. A dispatch that starts later is armed when it's next.
- **Fixed neighbouring slots:** the guard assumes the slots either side of `GUARD_SLOT` keep the start times you configured.

## Related projects

For monitoring and general control:

- the official [Home Assistant Sunsynk integration](https://www.home-assistant.io/integrations/sunsynk)
- [SunSynk_HA_Integration](https://github.com/MarcinG81/SunSynk_HA_Integration)
- [kellerza/sunsynk](https://github.com/kellerza/sunsynk) (local Modbus)

## Disclaimer

Not affiliated with Sunsynk, Deye, Inteless or Octopus Energy. You use it at your own risk. See [DISCLAIMER.md](DISCLAIMER.md).

## Contributing

Issues and pull requests are welcome. Reports of how your inverter and firmware behave are especially useful (see the timer quirks).

- Please run `node tests/run.js` before opening a PR, and add a test for any change to a Code node.
- Never commit a `.env` file or any credentials.

## Licence

MIT, © 2026 Matthew Glover. See [LICENSE](LICENSE).
