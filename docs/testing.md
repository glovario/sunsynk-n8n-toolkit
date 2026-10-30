# Testing

## Offline tests

```sh
node tests/run.js
```

- **What you need:** Node.js only, with no npm packages. The minimum Node version is **TBD**. The tests use `async`, `??` and `assert.match`, so Node 16 or later is likely.
- **What it does:** it loads the real Code-node source from `workflows/*.json` and runs it with mocked n8n globals (`$`, `$env`, `$getWorkflowStaticData`, `this.helpers.httpRequest`) and a fixed clock.
- **Network:** nothing goes to the network or to an inverter.
- **Exit code:** 0 when every test passes, 1 otherwise.

Currently **45/45** pass. They cover:
- arm then unplugged, which writes the restore settings
- dry-run replies not cached, then a real write, then `no_change`, then a failed write
- Octopus: GraphQL error on devices, missing `flexPlannedDispatches` data, a retried network error, and Plan never arming without a successful query
- a dispatch tomorrow not armed today, a later dispatch waiting until the lead-in, and an out-of-order arm start held
- leaving dry run without the slot neighbours is a config error
- UK clock changes: spring forward 2027 and fall back 2026, both window edges
- successive polls in one dispatch keep the same start and write once
- plug gate: timeout, 401, `unavailable` and an empty body each restore instead of arming
- an already-armed slot restored on plug error, with the stored start cleared
- restore when the plug can't be read, and arm when plugged in
- a blocked `crypto` module gives a clear error
- Octopus outage: error routed to Plan (continue on error); arm stores start and end; a verified arm stays until the stored end, then restores; unverified arms (dry run, failed read-back, plug refused) and arms with no stored end restore; end-to-end restore write; a consecutive-failure count that resets on success
- whole executions with n8n's persistence rule (static data saved only when the execution succeeds; a failed one discards its changes): outage runs succeed and keep their state; repeated outage polls after a verified restore don't rewrite and the failure count climbs; a dispatch end extended with an arm `no_change` then an outage stays armed until the new end; an alert sub-workflow that fails doesn't fail the run or lose state
- alert nodes: `Octopus Alert` never throws and sends only when Octopus failed and `GUARD_ALERT_WORKFLOW_ID` is set; `Send Alert` doesn't wait and continues on error
- slot order across midnight: slot 1 (prev = slot 6), slot 6 (next = 00:00) and a middle slot
- Config: 16:00 restore default, duplicate and out-of-order slot starts rejected, Sell cross-checks only when `SELL_ENABLED=true`

Add a test for any change to a Code node.

## Live test checklist

There was no review checklist on hand, so this one is **derived from the code**. It has not yet been run on a real system. Record the inverter model, firmware and n8n version (all **TBD**) when you do.

### Setup
- [ ] n8n starts with `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, and the runner has them too if you use one.
- [ ] Control's webhook rejects a call without the header, and accepts one with it.
- [ ] A dry-run call to Control (`set_charge_cap`, `cap5: 50`) returns `ok: true, dry_run: true, would_write`. This also proves that login works.

### Guard, still in dry run
- [ ] A run with no extra dispatch gives `mode: restore` and `action: dry_run`.
- [ ] A real extra dispatch (or one outside off-peak) is armed 20 minutes before at the latest, with `sellTimeN` equal to the dispatch start, and stays the same on every poll until it ends.
- [ ] After the dispatch, the next run gives `mode: restore`.
- [ ] With the plug gate: an unplugged car gives restore, and a wrong `HA_TOKEN` (401) gives restore with `plug_error`.
- [ ] An Octopus failure (e.g. a wrong API key) gives `mode: restore` (nothing was verified-armed in dry run), the execution **succeeds**, and `octopus_failures` goes up by one per run. With `GUARD_ALERT_WORKFLOW_ID` set, your alert workflow gets `Octopus unavailable (N consecutive runs): …`; break the alert workflow on purpose and check the guard execution still succeeds.

### Live
Before going live, read the [manual recovery procedure](safety.md#emergency-manual-recovery): turning writes off doesn't undo an armed slot.
- [ ] Set `GUARD_SLOT_PREV_START` / `GUARD_SLOT_NEXT_START` to match the inverter.
- [ ] With `SUNSYNK_WRITES_ENABLED=true` and `GUARD_DRY_RUN=false`, the first restore gives `action: written`, every reply `ok: true` with empty `mismatches`, and the Sunsynk app shows the slot as configured.
- [ ] The next run gives `no_change`.
- [ ] During an extra dispatch: armed (grid charge on, `capN = GUARD_CAP_SOC`), and the battery doesn't discharge into the car.
- [ ] After it: restored to `GUARD_RESTORE_*`.
- [ ] Protected slots are unchanged throughout.
- [ ] Both `timeNOn` and `timeNon` behave as expected on your firmware (see [timer-quirks.md](timer-quirks.md)).
- [ ] Optional Sell: replies `ok: true`, and the inverter exports from `SELL_START` down to `SELL_FLOOR_SOC`.
- [ ] Optional Sell: `sellTimeNEn` behaviour noted if `SELL_WRITE_ENABLE_FLAG=true`.
- [ ] Across a UK clock change (if possible), the off-peak edges are still treated as normal off-peak.

### Rollback
1. Disable future writes first: deactivate Sunsynk Control, or set `SUNSYNK_WRITES_ENABLED=false` and restart n8n. This does not restore the timer.
2. Restore the slot and grid charge by hand in the Sunsynk app, then re-open the timer and verify. See [safety.md: Emergency manual recovery](safety.md#emergency-manual-recovery).
