"""Shared helpers: load the IO EV Guard blueprint into an in-memory test Home Assistant."""
from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path

import pytest
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState, HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component

BLUEPRINT = Path(__file__).resolve().parents[2] / "blueprints" / "automation" / "io-ev-guard.yaml"
DISPATCH = "binary_sensor.octopus_energy_test_intelligent_dispatching"
PLUG = "sensor.car_plug"
HELPER = "input_text.io_ev_guard_state"
AUTOMATION = "automation.io_ev_guard"

WRITE_ACTION = [
    {
        "action": "test.write",
        "data": {
            "slot": "{{ slot }}",
            "start": "{{ start }}",
            "grid_charge": "{{ grid_charge }}",
            "cap": "{{ cap }}",
            "guard_mode": "{{ guard_mode }}",
        },
    },
    # Stands in for a real read-back check (e.g. Sunsynk Control's verified ok response).
    {"variables": {"write_verified": True}},
]


class Guard:
    def __init__(self, hass: HomeAssistant, caplog) -> None:
        self.hass = hass
        self.caplog = caplog
        self.calls: list[ServiceCall] = []
        self.fail_writes = False

    async def boot(self, **inputs) -> None:
        """Set up the automation as during a Home Assistant start, before EVENT_HOMEASSISTANT_STARTED.

        Newer HA arms triggers in a startup job while starting; older HA (2025.4) arms them on STARTED
        and fires `homeassistant: start` triggers straight away. Call finish_boot() to complete the start.
        """
        new_core = hasattr(type(self.hass), "async_add_startup_job")
        self.hass.set_state(CoreState.starting if new_core else CoreState.not_running)
        await self.setup(**inputs)

    async def finish_boot(self) -> None:
        self.hass.set_state(CoreState.running)
        self.hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
        await self.hass.async_block_till_done()

    async def setup(self, **inputs) -> None:
        hass = self.hass
        base = {
            "dispatch_entity": DISPATCH,
            "state_entity": HELPER,
            "write_action": WRITE_ACTION,
            "slot_prev_start": "05:30",
            "slot_next_start": "18:00",
        }
        base.update(inputs)
        base = {k: v for k, v in base.items() if v is not ...}

        async def _write(call: ServiceCall) -> None:
            if self.fail_writes:
                raise HomeAssistantError("read-back did not match")
            self.calls.append(call)

        hass.services.async_register("test", "write", _write)
        assert await async_setup_component(hass, "input_text", {"input_text": {"io_ev_guard_state": {"max": 100}}})
        assert await async_setup_component(hass, "system_log", {})
        assert await async_setup_component(hass, "persistent_notification", {})
        assert await async_setup_component(
            hass,
            "automation",
            {
                "automation": {
                    "id": "io_ev_guard",
                    "alias": "IO EV Guard",
                    "use_blueprint": {"path": "glovario/io-ev-guard.yaml", "input": base},
                }
            },
        )
        await hass.async_block_till_done()

    def set_dispatch(self, state: str, start: datetime | None = None, end: datetime | None = None) -> None:
        attrs = {}
        if start is not None:
            attrs = {"current_start": start, "current_end": end}
        self.hass.states.async_set(DISPATCH, state, attrs)

    async def run(self) -> None:
        await self.hass.services.async_call(
            "automation", "trigger", {"entity_id": AUTOMATION, "skip_condition": True}, blocking=True
        )
        await self.hass.async_block_till_done()

    @property
    def helper(self) -> str:
        return self.hass.states.get(HELPER).state

    def writes(self) -> list[dict]:
        return [dict(c.data) for c in self.calls]

    def logged(self, text: str) -> bool:
        return any(text in r.getMessage() for r in self.caplog.records)


@pytest.fixture
async def guard(hass: HomeAssistant, tmp_path, caplog) -> Guard:
    await hass.config.async_set_time_zone("Europe/London")
    hass.config.config_dir = str(tmp_path)
    dest = tmp_path / "blueprints" / "automation" / "glovario"
    dest.mkdir(parents=True)
    shutil.copy(BLUEPRINT, dest / "io-ev-guard.yaml")
    caplog.set_level("DEBUG", logger="blueprints.io_ev_guard")
    return Guard(hass, caplog)


@pytest.fixture
def expected_lingering_timers() -> bool:
    """The blueprint's time and time_pattern triggers leave scheduled timers when a test ends."""
    return True
