"""Instantiate the blueprint (blank and set plug sensor) and run Home Assistant's own config check on it.

Usage: python tests/ha/check_config.py  (with homeassistant installed, e.g. from tests/ha/requirements.txt)
Builds a throwaway config dir under a temp folder; never touches a live Home Assistant.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BLUEPRINT = Path(__file__).resolve().parents[2] / "blueprints" / "automation" / "io-ev-guard.yaml"

CONFIG = """
homeassistant:
  name: blueprint-check
  time_zone: Europe/London
  latitude: 51.5
  longitude: 0
  elevation: 0
  unit_system: metric
  currency: GBP
  country: GB
input_text:
  io_ev_guard_state:
    max: 100
script:
  sunsynk_write:
    fields: {slot: {}, start: {}, grid_charge: {}, cap: {}}
    sequence:
      - action: system_log.write
        data:
          message: "write slot {{ slot }} start {{ start }} grid_charge {{ grid_charge }} cap {{ cap }}"
automation:
  - id: io_ev_guard_blank_plug
    alias: IO EV Guard (no plug sensor)
    use_blueprint:
      path: glovario/io-ev-guard.yaml
      input: &base
        dispatch_entity: binary_sensor.octopus_energy_test_intelligent_dispatching
        state_entity: input_text.io_ev_guard_state
        slot_prev_start: "05:30"
        slot_next_start: "18:00"
        write_action:
          - action: script.sunsynk_write
            data: {slot: "{{ slot }}", start: "{{ start }}", grid_charge: "{{ grid_charge }}", cap: "{{ cap }}"}
          - variables:
              write_verified: true
  - id: io_ev_guard_set_plug
    alias: IO EV Guard (plug sensor set)
    use_blueprint:
      path: glovario/io-ev-guard.yaml
      input:
        <<: *base
        plug_entities: [sensor.car_plug]
        dry_run: false
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ha-blueprint-check-") as d:
        cfg = Path(d)
        dest = cfg / "blueprints" / "automation" / "glovario"
        dest.mkdir(parents=True)
        shutil.copy(BLUEPRINT, dest / "io-ev-guard.yaml")
        (cfg / "configuration.yaml").write_text(CONFIG)
        hass = Path(sys.executable).with_name("hass")
        res = subprocess.run([str(hass), "--script", "check_config", "-c", str(cfg), "--info", "automation"],
                             capture_output=True, text=True, timeout=600)
        out = res.stdout + res.stderr
        bad = [l for l in out.splitlines() if "ERROR" in l or "Failed config" in l or "Invalid config" in l
               or "Missing input" in l]
        if res.returncode != 0 or bad:
            print(out)
            print("check_config FAILED", res.returncode, bad)
            return 1
        missing = [i for i in ("id: io_ev_guard_blank_plug", "id: io_ev_guard_set_plug") if i not in out]
        if missing:
            print(out)
            print("check_config did not list:", missing)
            return 1
        from homeassistant.const import __version__ as ha_version
        print(f"Home Assistant {ha_version} check_config OK: both instantiated automations (blank and set plug sensor) are valid")
        return 0


if __name__ == "__main__":
    sys.exit(main())
