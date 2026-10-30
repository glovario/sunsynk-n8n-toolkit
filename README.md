# sunsynk-n8n-toolkit

n8n workflows that stop an **Intelligent Octopus** EV charge from draining a **Sunsynk** (or Deye) home battery, plus an optional evening **Sell** (export) window.

> ⚠️ Read [DISCLAIMER.md](DISCLAIMER.md). This writes to your inverter through an unofficial API. **All writes are off by default.**

## The problem
On Intelligent Octopus, the car is often given "extra" cheap charging slots outside the normal 23:30–05:30 window. The house is billed at the cheap rate during those slots, but a Sunsynk battery doesn't know that, so it discharges into the car. The guard notices the extra slot and holds the battery with grid charge on one timer slot, then puts the slot back afterwards.

## What's included
| Workflow | What it does |
|---|---|
| `workflows/sunsynk-control.json` | The only workflow that talks to the inverter. It validates requests, needs a header key, is dry-run unless `SUNSYNK_WRITES_ENABLED=true`, and reads back every write. |
| `workflows/io-ev-guard.json` | Every 10 minutes it reads Octopus planned dispatches, finds the extra ones, and arms or restores one timer slot. It only writes when something changes. The plug-in gate is optional. Works with any IO-supported EV or charger. |
| `workflows/evening-sell.json` | Sets one slot to export from a set time, down to a battery floor. Off by default. |

## Tested on
- Sunsynk hybrid, UK, Sunsynk Connect cloud. **Model, firmware and n8n version: to be filled in before release.**
- Deye/Inteless (`pv.inteless.com`): untested.

## Prerequisites
- n8n with Code-node access to environment variables: `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
- Node's built-in `crypto` module allowed in Code nodes: `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (add it to any existing comma-separated list). Without it **Sunsynk Login** stops with a clear error, even in dry run.
- If you run n8n with **external task runners** (`N8N_RUNNERS_MODE=external`), set both variables on the runner container too (for the `n8nio/runners` image, also allow them in its `n8n-task-runners.json`). Restart after changing them.

## Setup
1. Import the three JSON files into n8n.
2. Copy `config/example.env` to `.env`, fill it in, and load it into n8n's environment (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`). The settings are described in `config/schema.json`.
3. In **Sunsynk Control**, create a Header Auth credential matching `SUNSYNK_CONTROL_HEADER_NAME`/`_VALUE` and attach it to the Webhook node.
4. Activate Sunsynk Control and the guard, and leave the dry-run settings as they are.
5. Watch a few days of executions. Each run shows the planned mode, the extra window and the exact fields it *would* write.
6. Set `GUARD_SLOT_PREV_START` and `GUARD_SLOT_NEXT_START` to the start times of the slots either side of `GUARD_SLOT` (the guard refuses to arm a start time out of order).
7. When you're happy, set `SUNSYNK_WRITES_ENABLED=true` and `GUARD_DRY_RUN=false`. Do the same for Sell if you want it.

## Safety design
- Two separate off switches (Control and the workflow itself), both defaulting to off.
- Write commands only accept timer fields: `sellTimeN`, `timeNOn`/`timeNon`, `capN` and `sellTimeNEn`, with range checks.
- The guard never touches `GUARD_PROTECTED_SLOTS` and never writes `sellTimeNEn`.
- Every write is read back, because a "success" reply can be wrong.
- Octopus API or GraphQL errors, or missing data, stop the run with an error (after retries). They're never treated as "no dispatches", so the guard never restores just because a query failed.
- The guard only arms for an extra dispatch that is running or starts within `GUARD_LEAD_IN_MIN`. Timer slots are daily times with no date, so a dispatch later today or tomorrow waits until it's close.
- If the car is unplugged (optional gate), the guard writes the restore settings, not the arm ones.
- The stop marker is saved only after a real, read-back-verified write. Dry-run replies are never cached, so turning writes on takes effect on the next run.
- Off-peak boundaries are built from local calendar dates in `GUARD_TIMEZONE`, so they're correct on clock-change nights.
- Secrets live only in n8n env vars or credentials, never in workflow JSON.

## Tests
`node tests/run.js` runs the real Code-node source from the workflow files offline with mocked n8n, Octopus and Sunsynk replies. It covers arm then unplugged, dry run then writes on, GraphQL errors and missing data, dispatches tomorrow and later today, slot order, both UK clock changes, and blocked `crypto`. No network or inverter is needed.

## Timer quirks
See [docs/timer-quirks.md](docs/timer-quirks.md).

## Troubleshooting
- *Login failed*: turn off MFA on the Sunsynk account, or use a separate account without MFA.
- *"needs Node's built-in 'crypto' module"*: see Prerequisites.
- *"Octopus … failed after 3 tries"*: Octopus API or GraphQL error. Nothing was changed. It retries on the next run.
- *Config error*: the message lists every setting that's wrong.
- *Mismatches after write*: see the timer quirks above.

## Related projects
Monitoring and general control: the official [Home Assistant Sunsynk integration](https://www.home-assistant.io/integrations/sunsynk), [SunSynk_HA_Integration](https://github.com/MarcinG81/SunSynk_HA_Integration), [kellerza/sunsynk](https://github.com/kellerza/sunsynk) (local Modbus).

## Licence
MIT. See [LICENSE](LICENSE).
