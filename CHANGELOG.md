# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No version numbering scheme has been adopted yet.

**No releases are tagged yet.** Everything below has been merged to `main` but not released, so it sits under [Unreleased]. Dates are merge dates (GMT). The project was created on 2026-10-30 with the MIT licence.

## [Unreleased]

### Added

- IO EV Guard workflow (`workflows/io-ev-guard.json`). During Intelligent Octopus extra EV dispatches outside the off-peak window, it grid-charges one inverter timer slot so the EV doesn't drain the house battery. The plug-in gate via Home Assistant is optional. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- Evening Sell workflow (`workflows/evening-sell.json`): an evening export window on a separate timer slot, off by default. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- Sunsynk Control workflow (`workflows/sunsynk-control.json`): the only workflow that writes to the inverter. It requires header auth, accepts only allowed fields per command and reads each write back. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- `config/schema.json` and `config/example.env` (placeholders only), `docs/timer-quirks.md`, `DISCLAIMER.md` and `.gitignore`. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- Offline test harness `tests/run.js`, which runs the real Code-node source against mocked n8n, Octopus, Sunsynk and Home Assistant replies. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- Documentation set under `docs/`: overview, installation, configuration guide, per-workflow walkthroughs, safety model, testing (including a live test checklist), troubleshooting and FAQ. Merged 2026-10-30 ([#2](https://github.com/glovario/sunsynk-n8n-toolkit/pull/2)).
- GitHub issue templates for bug reports and feature requests. Merged 2026-10-30 ([#2](https://github.com/glovario/sunsynk-n8n-toolkit/pull/2)).
- `.github/CODEOWNERS`. Merged 2026-10-30 ([#4](https://github.com/glovario/sunsynk-n8n-toolkit/pull/4)).
- Optional alert on Octopus failures: `GUARD_ALERT_WORKFLOW_ID` names an n8n workflow that the guard calls, without waiting, when an Octopus query fails. Merged 2026-10-30 ([#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- GitHub Actions CI (`.github/workflows/ci.yml`): runs `node tests/run.js` and a gitleaks scan, with actions pinned to commit SHAs. The README has a CI badge. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).
- `docs/validation-status.md`, which lists what has not yet been confirmed on a live system. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).
- Tests that parse `config/example.env` the way `docker --env-file` does and check every value against `config/schema.json`, in both directions. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).

- Home Assistant automation blueprint for the IO EV Guard (`blueprints/automation/io-ev-guard.yaml`) and `docs/blueprint.md`. It is dry run by default, fails closed and is not live-tested. Offline structure tests use js-yaml, a new devDependency, and CI now runs `npm ci`. (pending, PR #8)

### Changed

- README rewritten with the problem, each workflow's triggers, inputs and outputs, a diagram, prerequisites, quick start and a configuration reference. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1), [#2](https://github.com/glovario/sunsynk-n8n-toolkit/pull/2)).
- The default `GUARD_RESTORE_START` is now 16:00 (previously 18:00, the same as `SELL_START`). Existing setups that relied on the old 18:00 default with Sell at 18:00 must now set `GUARD_RESTORE_START`. Merged 2026-10-30 ([#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- Config now rejects duplicate or out-of-order slot starts. When `SELL_ENABLED=true`, it also checks the guard's slot starts against `SELL_START`. Merged 2026-10-30 ([#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- Removed the duplicate `.GitHub/CODEOWNERS` (wrong-case directory), leaving `.github/CODEOWNERS`. Merged 2026-10-30 ([#5](https://github.com/glovario/sunsynk-n8n-toolkit/pull/5)).
- `GUARD_PLUG_ON_STATES`: configured entries and the Home Assistant state are trimmed and lower-cased, so `on, plugged_in` works. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).
- Docs: `GUARD_PROTECTED_SLOTS` is described as the slots the IO EV Guard must never modify. The configuration guide explains that user-specific settings and secrets go in environment variables, while built-in defaults live in the Code nodes. Hard-coded test and setting counts were removed. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).

### Fixed

- An unplugged car now writes the restore settings rather than the arm settings. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- The guard arms only for a dispatch that is running or starts within `GUARD_LEAD_IN_MIN`, and it checks slot order. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- Off-peak windows use local calendar dates, so both UK clock changes are handled. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- The armed slot start is fixed once per dispatch, so it no longer moves on every poll. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- An Octopus outage no longer leaves a slot armed past its dispatch. The guard keeps a verified arm only until the stored dispatch end, then restores. Merged 2026-10-30 ([#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- `GUARD_SLOT=1` now works across midnight: the slot-order check wraps for slots 1 and 6. Merged 2026-10-30 ([#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- `config/example.env` now works with `docker --env-file`: inline comments were moved onto their own lines, because docker reads them into the values. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).

### Security

- Writes are off by default. Nothing is written until `SUNSYNK_WRITES_ENABLED=true` is set and a request sends `dry_run:false`. `GUARD_DRY_RUN` and `SELL_DRY_RUN` default to true, and the guard never touches protected slots. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- The plug gate fails closed: if the plug state can't be read, the guard restores the slot instead of arming. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1)).
- Octopus API or GraphQL errors, or missing data, are never read as "no dispatches", and the guard never arms a new dispatch without a successful query. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1), [#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- The guard records an arm only after a real, read-back-verified write. Merged 2026-10-30 ([#1](https://github.com/glovario/sunsynk-n8n-toolkit/pull/1), [#3](https://github.com/glovario/sunsynk-n8n-toolkit/pull/3)).
- Secret scanning with gitleaks runs in CI. Merged 2026-10-30 ([#6](https://github.com/glovario/sunsynk-n8n-toolkit/pull/6)).

[Unreleased]: https://github.com/glovario/sunsynk-n8n-toolkit/commits/main
