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

## Setup
1. Import the three JSON files into n8n.
2. Copy `config/example.env` to `.env`, fill it in, and load it into n8n's environment (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`). The settings are described in `config/schema.json`.
3. In **Sunsynk Control**, create a Header Auth credential matching `SUNSYNK_CONTROL_HEADER_NAME`/`_VALUE` and attach it to the Webhook node.
4. Activate Sunsynk Control and the guard, and leave the dry-run settings as they are.
5. Watch a few days of executions. Each run shows the planned mode, the extra window and the exact fields it *would* write.
6. When you're happy, set `SUNSYNK_WRITES_ENABLED=true` and `GUARD_DRY_RUN=false`. Do the same for Sell if you want it.

## Safety design
- Two separate off switches (Control and the workflow itself), both defaulting to off.
- Write commands only accept timer fields: `sellTimeN`, `timeNOn`/`timeNon`, `capN` and `sellTimeNEn`, with range checks.
- The guard never touches `GUARD_PROTECTED_SLOTS` and never writes `sellTimeNEn`.
- Every write is read back, because a "success" reply can be wrong.
- Secrets live only in n8n env vars or credentials, never in workflow JSON.

## Timer quirks
See [docs/timer-quirks.md](docs/timer-quirks.md).

## Troubleshooting
- *Login failed*: turn off MFA on the Sunsynk account, or use a separate account without MFA.
- *Config error*: the message lists every setting that's wrong.
- *Mismatches after write*: see the timer quirks above.

## Related projects
Monitoring and general control: the official [Home Assistant Sunsynk integration](https://www.home-assistant.io/integrations/sunsynk), [SunSynk_HA_Integration](https://github.com/MarcinG81/SunSynk_HA_Integration), [kellerza/sunsynk](https://github.com/kellerza/sunsynk) (local Modbus).

## Licence
MIT. See [LICENSE](LICENSE).
