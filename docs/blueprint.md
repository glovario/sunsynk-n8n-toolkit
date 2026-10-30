# Home Assistant blueprint: IO EV Guard

> ⚠️ **Not live-tested.** This blueprint has been checked only offline: its YAML structure is tested in `tests/run.js`, its behaviour is tested inside a real (throwaway, local) Home Assistant core by `tests/ha/`, and Home Assistant's own `check_config` accepts it (see [Testing the blueprint](#testing-the-blueprint)). It hasn't yet run on a real Home Assistant instance, against the Octopus Energy integration, or against an inverter. **Dry run is on by default.** See [validation status](validation-status.md).

[![Open your Home Assistant instance and show the blueprint import dialog with this blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fraw.githubusercontent.com%2Fglovario%2Fsunsynk-n8n-toolkit%2Fmain%2Fblueprints%2Fautomation%2Fio-ev-guard.yaml)

[`blueprints/automation/io-ev-guard.yaml`](../blueprints/automation/io-ev-guard.yaml) is a Home Assistant automation that makes the same decision as the n8n [IO EV Guard](workflows/io-ev-guard.md):
- **Extra dispatch active** (and the plug gate passes, if you set one up): arm one timer slot with its start time, grid charge on and the battery cap.
- **No dispatch, or the dispatch has ended:** restore the slot.

It doesn't write to the inverter itself. It calls a **write action** that you choose, so it works with any way of writing Sunsynk settings. One option is the toolkit's [Sunsynk Control](workflows/sunsynk-control.md) webhook, shown [below](#example-write-action-the-toolkits-sunsynk-control-webhook).

Use either the blueprint or the n8n guard, not both on the same slot.

## Prerequisites

- **Home Assistant 2025.4.0 or later** (declared as `min_version` in the blueprint). The write check relies on a `variables` action inside the write action updating the blueprint's own variable, which is the variable scoping introduced in 2025.4. The tests pass on 2025.4.0 and 2026.10.4. Earlier versions are not tested.
- **An `input_text` helper** (max length 100 or more, initial value empty) that the blueprint uses as its memory: the dispatch it armed, the start it chose, and the last write it verified. Create it under Settings → Devices & services → Helpers → Text. Use one helper per automation and don't edit it by hand.
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
| Guard state helper | (required) | The `input_text` helper above. |
| Plug sensor (optional) | none | Turns on the plug gate. Only the first entity is read. Leaving it blank is safe: no plug trigger is created. |
| Plug-on states | `on,plugged_in,true` | Comma list. Both the entries and the sensor state are trimmed and lower-cased, as with `GUARD_PLUG_ON_STATES`. |
| Timer slot | `5` | The one slot this automation may change (1–6). |
| Previous / next slot start | blank | `HH:MM` (24-hour, two digits, e.g. `05:30`). **Both are required when dry run is off.** An arm start outside them is **held**: nothing is written. This wraps past midnight for slots 1 and 6 only, as in the n8n guard. |
| Off-peak start / end | `23:30` / `05:30` | A dispatch inside this window doesn't arm, because the off-peak rate already applies. |
| Battery cap while armed | `100` % | `capN` while armed. |
| Restore start time | `16:00` | Slot start to put back. Like `GUARD_RESTORE_START`, it defaults to 16:00 so it doesn't clash with the Sell default of 18:00. |
| Restore grid charge | off | Grid charge value to put back. |
| Restore battery cap | `50` % | `capN` to put back. |
| Resync hours | `6` | After a verified write, an identical write is skipped until this many hours have passed or Home Assistant restarts. `0` writes on every run. |
| Dry run | **on** | Logs and notifies only. The write action is never called. |
| Write action | (required, no default) | Runs when dry run is off. It receives `slot`, `start`, `grid_charge`, `cap` and `guard_mode`. It **must** end with `- variables: {write_verified: true}` once the write has been confirmed (see [the write contract](#the-write-contract)). |

## When it runs

It runs in these cases:
- the dispatching sensor's state changes (attribute-only updates are ignored)
- the plug sensor becomes on, off or unreadable (template triggers that never fire when no plug sensor is set)
- the off-peak start and end times are reached
- every 30 minutes (a resync check; an identical verified write is skipped)
- Home Assistant starts (always rewrites, because the inverter may have drifted while HA was down)

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
| Invalid configuration: a neighbour time not `HH:MM`, a neighbour missing while dry run is off, both neighbours equal, the restore start equal to a neighbour or outside them, or (for slots 2–5) previous after next | **config error**: nothing is written, an error is logged and the run stops with an error, in dry run too |
| Write action missing `write_verified: true`, or failing | error logged, run stops with an error, nothing is recorded as written, so the next run retries |

The **arm start** is chosen once per dispatch, from full date-times (so it is safe across midnight and clock changes):
1. take the later of the dispatch's `current_start` and the most recent off-peak end;
2. clamp it to now, so a dispatch first seen late (for example after a restart) never gets a start in the past;
3. store it in the helper, and reuse it for the rest of that dispatch so it doesn't creep forward.

When the dispatch ends or the sensor becomes unreadable, the slot is restored straight away and the stored start is forgotten.

## The write contract

The blueprint records a write only after it is confirmed:
1. before calling the write action it clears its "last verified write" record;
2. it runs the write action with `write_verified` set to `false`;
3. only if the write action set `write_verified: true` does it record the write (values and time).

If the write action fails or never sets the flag, the run stops with an error and the next trigger (at most 30 minutes later) tries again. A recorded write is skipped while it is identical and newer than **Resync hours**, and always redone after a restart.

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

Then set the blueprint's **Write action** to the script call followed by the confirmation flag. The script stops with an error if any call isn't confirmed, which aborts the write action before the flag is set:

```yaml
- action: script.io_ev_guard_write
  data:
    slot: "{{ slot }}"
    start: "{{ start }}"
    grid_charge: "{{ grid_charge }}"
    cap: "{{ cap }}"
- variables:
    write_verified: true
```

This example hasn't been run live (**TBD**). That a script's `stop … error: true` aborts the calling write action is how Home Assistant behaves in the tests (a failing action stops the run), but the exact `rest_command` response fields (`status`, `content.ok`) are **TBD**: check them on your Home Assistant version.

## Differences from the n8n guard

- **Resync instead of a pure stop marker:** both skip a write that matches the last verified write. The blueprint also rewrites after a restart and after **Resync hours**, in case the inverter drifted.
- **No lead-in:** the n8n guard can arm up to `GUARD_LEAD_IN_MIN` before a dispatch. The blueprint arms when the sensor turns on.
- **No Octopus outage memory:** if the sensor goes `unavailable`, the blueprint restores straight away. The n8n guard keeps a verified arm until the stored dispatch end.
- **Off-peak overlap:** both trim a dispatch that started inside off-peak to the off-peak end. The blueprint also checks whether *now* is inside the window, with a trigger at the off-peak start and end.

## Testing the blueprint

Two offline layers, neither touching a live system:
- `node tests/run.js` checks the YAML structure (inputs, triggers, required fields).
- `tests/ha/` runs the blueprint in a real Home Assistant core, pinned in `tests/ha/requirements.txt` (homeassistant 2026.10.4 via pytest-homeassistant-custom-component 0.13.375):

```sh
python3.14 -m venv .venv-ha && . .venv-ha/bin/activate
pip install -r tests/ha/requirements.txt
python -m pytest tests/ha -p no:cacheprovider      # behaviour tests
python tests/ha/check_config.py                    # Home Assistant's own check_config
```

`check_config.py` builds a throwaway config directory with two instances of the blueprint (blank plug sensor, and plug sensor set) and runs `hass --script check_config`. Because `check_config` exits 0 even when a blueprint fails to instantiate, the script also fails on any logged `ERROR`.

## Notes for editors

`!input` is a custom YAML tag. Generic YAML tools need a custom loader to read the file. `tests/run.js` registers one with js-yaml (YAML 1.1 schema, like Home Assistant's PyYAML), so run `npm ci` before `node tests/run.js`.
