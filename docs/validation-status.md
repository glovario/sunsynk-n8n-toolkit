# Validation status

The offline tests (`node tests/run.js`, run in CI) exercise the real Code-node source against mocked n8n, Octopus, Sunsynk and Home Assistant replies. They can't prove how the real services behave. These items are still **open** and need a live run before they can be called verified:

| Area | Open question | Status |
|---|---|---|
| n8n version | Minimum supported and verified n8n version, including Code-node task runners (internal and external) and the Execute Sub-workflow node used for alerts. | **TBD** |
| Inverter | Inverter model and firmware the workflows were run against. | **TBD** |
| Timer writes | Whether a timer write is applied as sent and read back the same, including "success" replies that change nothing (see [timer quirks](timer-quirks.md)). | **TBD** |
| Evening Sell | Whether the Sell slot actually exports, and whether the inverter enforces the `capN` SOC floor (and `sellTimeNEn` where enabled). | **TBD** |
| Alerts | Whether alerts from Octopus Alert reach the sub-workflow set by `GUARD_ALERT_WORKFLOW_ID` and are delivered to you. | **TBD** |
| Home Assistant blueprint | Whether `blueprints/automation/io-ev-guard.yaml` imports and runs on a real Home Assistant (minimum version, `entity_id: []` for an empty plug sensor, the `current_start` attribute format, and the example `rest_command`/script write path). | **TBD** |
| Octopus dispatches | Behaviour against real dispatch changes and cancellations from Intelligent Octopus, not only mocked ones. | **TBD** |

When one of these is confirmed, record the n8n version, inverter model, firmware and date in the README's **Tested status** section and update this table.
