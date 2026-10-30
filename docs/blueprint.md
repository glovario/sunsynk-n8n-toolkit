# Home Assistant blueprint: IO EV Guard

> ⚠️ **Not live-tested.** This blueprint has been checked only offline: its YAML structure is tested in `tests/run.js`, and its templates were rendered against simulated states. It hasn't yet run on a real Home Assistant instance, against the Octopus Energy integration, or against an inverter. **Dry run is on by default.** See [validation status](validation-status.md).

[![Open your Home Assistant instance and show the blueprint import dialog with this blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2Fglovario%2Fsunsynk-n8n-toolkit%2Fmain%2Fblueprints%2Fautomation%2Fio-ev-guard.yaml)

[`blueprints/automation/io-ev-guard.yaml`](../blueprints/automation/io-ev-guard.yaml) is a Home Assistant automation that makes the same decision as the n8n [IO EV Guard](workflows/io-ev-guard.md):
- **Extra dispatch active** (and the plug gate passes, if you set one up): arm one timer slot with its start time, grid charge on and the battery cap.
- **No dispatch, or the dispatch has ended:** restore the slot.

It doesn't write to the inverter itself. It calls a **write action** that you choose, so it works with any way of writing Sunsynk settings. One option is the toolkit's [Sunsynk Control](workflows/sunsynk-control.md) webhook, shown [below](#example-write-action-the-toolkits-sunsynk-control-webhook).

Use either the blueprint or the n8n guard, not both on the same slot.

## Prerequisites

- **Home Assistant** with blueprint support. The blueprint uses the `triggers:`/`actions:` syntax and `trigger: state`, which need a recent release. The minimum version is **TBD**.
- **A dispatching sensor**, for example from the [BottlecapDave Octopus Energy integration](https://bottlecapdave.github.io/HomeAssistant-OctopusEnergy/entities/intelligent/): `binary_sensor.octopus_energy_{{DEVICE_ID}}_intelligent_dispatching`.
  - Its docs say it is on during an active dispatch for a single intelligent device, and that it doesn't come on during a bump charge.
  - The blueprint reads its `current_start` attribute ("The date/time when the dispatching or off peak rate started").
  - The integration warns that the sensor can be on during a dispatch outside off-peak even when the car isn't actually charging. That is one reason to use the plug gate.
- **Optional:** a sensor that shows whether the car is plugged in.
- **A write action**, for example a script that calls Sunsynk Control.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| Dispatching sensor | (required) | Binary sensor that is `on` during a dispatch. |
| Plug sensor (optional) | none | Turns on the plug gate. Only the first entity is read. |
| Plug-on states | `on,plugged_in,true` | Comma list. Both the entries and the sensor state are trimmed and lower-cased, as with `GUARD_PLUG_ON_STATES`. |
| Timer slot | `5` | The one slot this automation may change (1–6). |
| Previous / next slot start (optional) | blank | `HH:MM`. When both are set, an arm start outside them is **held**: nothing is written. This wraps past midnight for slots 1 and 6 only, as in the n8n guard. |
| Off-peak start / end | `23:30` / `05:30` | A dispatch inside this window doesn't arm, because the off-peak rate already applies. |
| Battery cap while armed | `100` % | `capN` while armed. |
| Restore start time | `16:00` | Slot start to put back. Like `GUARD_RESTORE_START`, it defaults to 16:00 so it doesn't clash with the Sell default of 18:00. |
| Restore grid charge | off | Grid charge value to put back. |
| Restore battery cap | `50` % | `capN` to put back. |
| Dry run | **on** | Logs and notifies only. The write action is never called. |
| Write action | none | Runs when dry run is off. It receives `slot`, `start`, `grid_charge`, `cap` and `guard_mode`. |

## When it runs

It runs in these cases:
- the dispatching sensor's state changes (attribute-only updates are ignored)
- the plug sensor's state changes
- the off-peak start and end times are reached
- Home Assistant starts

It runs in `queued` mode.

## Decision and fail-closed behaviour

| Situation | Result |
|---|---|
| Dispatching sensor is `unavailable`, `unknown` or empty | **restore** (never arm) |
| Sensor is `on` outside off-peak, the plug gate is off or plugged in, and the slot order is OK | **arm** |
| Sensor is `on` inside off-peak | restore |
| Sensor is `off` | restore |
| Plug gate set and the plug state is `unavailable`, `unknown` or empty | **restore** instead of arming ("plug gate: … restoring instead of arming") |
| Plug gate set and the plug state is not in the plug-on states | restore |
| Arm start outside the previous and next slot starts | **hold**: nothing is written, and a warning is logged |
| Restore start outside the previous and next slot starts | nothing is written, and the run stops with an error |

The **arm start** is the dispatch's `current_start` in local time, which stays the same for the whole dispatch, so the slot isn't rewritten on every update. If that time falls inside off-peak or is missing, the current time is used instead.

## Dry run

While **Dry run** is on, the automation does two things:
- creates a persistent notification, `IO EV Guard (dry run)`, saying what it would write and why
- writes an info line to the system log under `blueprints.io_ev_guard`

The write action is never called. Watch a few dispatches like this before you turn dry run off.

## Example write action: the toolkit's Sunsynk Control webhook

Sunsynk Control (`workflows/sunsynk-control.json`) accepts `POST /webhook/sunsynk-control` with Header Auth and a JSON body `{ command, params, sn?, dry_run }`.
- Allowed commands include `set_sell_time` (`sellTimeN`), `set_grid_charge` (`timeNOn`/`timeNon`) and `set_charge_cap` (`capN`, 10–100).
- It writes only when `dry_run` is `false` **and** `SUNSYNK_WRITES_ENABLED=true` in n8n.
- It replies `{ ok, dry_run, … }`, and `ok` is true only when the read-back matches.

The n8n guard sends the same three commands; this example mirrors that.

`configuration.yaml`:

```yaml
rest_command:
  sunsynk_control:
    url: "http://n8n.local:5678/webhook/sunsynk-control"   # your n8n webhook URL
    method: post
    headers:
      X-Control-Key: !secret sunsynk_control_key          # SUNSYNK_CONTROL_HEADER_NAME: SUNSYNK_CONTROL_HEADER_VALUE
    content_type: "application/json"
    payload: '{{ {"command": command, "params": params, "dry_run": false} | to_json }}'
```

`scripts.yaml`:

```yaml
io_ev_guard_write:
  alias: IO EV Guard write (Sunsynk Control)
  mode: queued
  fields:
    slot: {}
    start: {}
    grid_charge: {}
    cap: {}
  sequence:
    - variables:
        n: "{{ slot | int }}"
        calls:
          - command: set_sell_time
            params: "{{ {'sellTime' ~ n: start} }}"
          - command: set_grid_charge
            params: "{{ {'time' ~ n ~ 'On': '1' if grid_charge | bool else '0', 'time' ~ n ~ 'on': 'true' if grid_charge | bool else 'false'} }}"
          - command: set_charge_cap
            params: "{{ {'cap' ~ n: cap | int} }}"
    - repeat:
        for_each: "{{ calls }}"
        sequence:
          - action: rest_command.sunsynk_control
            data:
              command: "{{ repeat.item.command }}"
              params: "{{ repeat.item.params }}"
            response_variable: reply
          - if:
              - condition: template
                value_template: "{{ reply.status != 200 or not (reply.content.ok | default(false)) }}"
            then:
              - stop: "Sunsynk Control did not confirm {{ repeat.item.command }}"
                error: true
```

Then set the blueprint's **Write action** to:

```yaml
- action: script.io_ev_guard_write
  data:
    slot: "{{ slot }}"
    start: "{{ start }}"
    grid_charge: "{{ grid_charge }}"
    cap: "{{ cap }}"
```

This example hasn't been run live (**TBD**). Check the exact `rest_command` response fields on your Home Assistant version.

## Differences from the n8n guard

- **No stop marker:** the n8n guard skips a write that matches its last verified write. The blueprint relies on state-change triggers instead, so the same values can be written again, for example at the off-peak boundaries or on restart.
- **No lead-in:** the n8n guard can arm up to `GUARD_LEAD_IN_MIN` before a dispatch. The blueprint arms when the sensor turns on.
- **No Octopus outage memory:** if the sensor goes `unavailable`, the blueprint restores straight away. The n8n guard keeps a verified arm until the stored dispatch end.
- **Off-peak overlap:** the n8n guard trims dispatches that overlap off-peak. The blueprint checks whether *now* is inside the window, plus a trigger at the off-peak start and end.

## Notes for editors

`!input` is a custom YAML tag. Generic YAML tools need a custom loader to read the file. `tests/run.js` registers one with js-yaml (YAML 1.1 schema, like Home Assistant's PyYAML), so run `npm ci` before `node tests/run.js`.
