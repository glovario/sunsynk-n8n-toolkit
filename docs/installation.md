# Installation

Each step below links to the detail. Every setting is described in [configuration.md](configuration.md).

## Prerequisites

Have all of these ready before you start:

- **n8n:** a self-hosted instance (minimum version **TBD**) with:
  - `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
  - `NODE_FUNCTION_ALLOW_BUILTIN=crypto`
  - both also set on the task runner, if you use external runners
- **A Sunsynk Connect account without MFA,** and your inverter serial number. No plant ID is needed.
- **An Octopus account on Intelligent Octopus** with your EV or charger linked, plus an API key and your account number (`A-…`).
- **The start times of the timer slots** either side of the slot the guard will use.
- **Optional:** a Home Assistant entity for "car plugged in", and a long-lived access token.

## 1. Check n8n

- You need a self-hosted n8n instance whose Code nodes can read environment variables and use `this.helpers.httpRequest`. The minimum supported n8n version is **TBD**.
- Set these on the n8n process:
  ```
  N8N_BLOCK_ENV_ACCESS_IN_NODE=false
  NODE_FUNCTION_ALLOW_BUILTIN=crypto
  ```
  - If you already allow other built-ins, add `crypto` to the comma-separated list.
  - Sunsynk Login needs `crypto`, even in dry run.
- **External task runners** (`N8N_RUNNERS_MODE=external`): set both variables on the runner container as well. For the `n8nio/runners` image, also allow them in its `n8n-task-runners.json`.
- Restart n8n (and the runner) after changing any of this.

## 2. Gather your details

- **Sunsynk Connect:**
  - Username and password, for an account **without MFA**.
  - Inverter serial number (Sunsynk app > Device > About), 6–12 digits.
  - No plant ID is needed.
- **Octopus:**
  - API key (from your Octopus account's developer settings).
  - Account number (`A-…`).
  - Optionally, the EV or charger device ID. If you leave it blank, the guard uses the first device of type `ELECTRIC_VEHICLES` or `CHARGE_POINTS` on the account.
- **Home Assistant (optional, for the plug gate):**
  - The state URL of an entity that shows whether the car is plugged in, e.g. `http://homeassistant.local:8123/api/states/binary_sensor.car_plugged_in`.
  - A long-lived access token.
- **Your inverter's current timer:** the start times of the slots either side of the slot the guard will use (slot 5 by default, so slots 4 and 6).

## 3. Set the environment variables

1. Copy `config/example.env` to `.env`. Never commit it.
2. Fill in the Sunsynk, Octopus and Control webhook values. For `SUNSYNK_CONTROL_HEADER_VALUE`, choose a long random string.
3. Leave the safety switches as they are:
   - `SUNSYNK_WRITES_ENABLED=false`
   - `GUARD_DRY_RUN=true`
   - `SELL_DRY_RUN=true`
   - `SELL_ENABLED=false`
   - `SELL_WRITE_ENABLE_FLAG=false`
4. Load the file into n8n's environment, e.g. with Docker `--env-file` or your compose file. The exact method depends on how you run n8n.
5. Restart n8n.

## 4. Import the workflows

In n8n, import each file from `workflows/`:
- `sunsynk-control.json` (Sunsynk Control (template))
- `io-ev-guard.json` (IO EV Guard (template))
- `evening-sell.json` (Sunsynk Evening Sell (template))

## 5. Create the webhook credential

1. In **Sunsynk Control**, open the **Webhook** node. It's set to Header Auth.
2. Create a Header Auth credential with:
   - **Name:** the value of `SUNSYNK_CONTROL_HEADER_NAME` (default `X-Control-Key`)
   - **Value:** the value of `SUNSYNK_CONTROL_HEADER_VALUE`
3. Attach the credential to the node and save.

The guard and Sell send this header on every call. `SUNSYNK_CONTROL_URL` must point at the webhook's production URL (default `http://127.0.0.1:5678/webhook/sunsynk-control`).

## 6. Activate and watch dry runs

1. Activate Sunsynk Control, then the guard. Activate Sell only if you want it.
2. Leave everything in dry run for a few days and check the executions:
   - **Guard:** each run shows `mode`, `extra_start` / `extra_end`, `next_extra_start`, `params` (what it would write) and `action: dry_run`.
   - **Control:** each run returns `would_write`.
3. If a run errors, see [troubleshooting.md](troubleshooting.md).

## 7. Set the slot neighbours

Set `GUARD_SLOT_PREV_START` and `GUARD_SLOT_NEXT_START` to the start times of slots `GUARD_SLOT - 1` and `GUARD_SLOT + 1` on your inverter. If `GUARD_SLOT` is 6, set `GUARD_SLOT_NEXT_START` to `00:00`.

The guard refuses to leave dry run without these, and it uses them to avoid writing a start time out of order.

## 8. Turn writes on

1. Set `SUNSYNK_WRITES_ENABLED=true` and `GUARD_DRY_RUN=false`, then restart n8n.
2. Check the next real write:
   - The guard's `action` should be `written`.
   - Each Control reply should have `ok: true` and an empty `mismatches`.
3. Check the slot in the Sunsynk app too.

For Sell, also set `SELL_ENABLED=true` and `SELL_DRY_RUN=false`. Check your DNO export limit and tariff first.

Before relying on it, go through the live checklist in [testing.md](testing.md).
