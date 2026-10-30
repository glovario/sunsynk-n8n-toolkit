"""Behaviour tests for blueprints/automation/io-ev-guard.yaml in a real (in-memory) Home Assistant Core.

All times are UTC instants; the test HA runs in Europe/London. Nothing here touches a live HA, n8n or inverter.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from homeassistant.setup import async_setup_component

from conftest import AUTOMATION, PLUG, WRITE_ACTION

UTC = timezone.utc


def t(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=UTC)


# ---- loading / triggers ----

async def test_loads_with_blank_plug_and_plug_triggers_never_fire(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")  # 14:40 BST
    await guard.setup(dry_run=False)
    assert guard.hass.states.get(AUTOMATION).state == "on"
    # Unrelated sensor changes must not fire anything (there is no plug sensor).
    guard.hass.states.async_set(PLUG, "unavailable")
    await guard.hass.async_block_till_done()
    guard.hass.states.async_set(PLUG, "on")
    await guard.hass.async_block_till_done()
    assert guard.writes() == []
    assert guard.hass.states.get(AUTOMATION).attributes.get("last_triggered") is None


async def test_set_plug_reacts_to_unavailable_and_recovery(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.hass.states.async_set(PLUG, "on")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.setup(dry_run=False, plug_entities=[PLUG])
    assert guard.hass.states.get(AUTOMATION).state == "on"
    await guard.run()
    assert [w["guard_mode"] for w in guard.writes()] == ["arm"]
    guard.hass.states.async_set(PLUG, "unavailable")  # plug sensor drops out: template trigger fires, restore
    await guard.hass.async_block_till_done()
    assert [w["guard_mode"] for w in guard.writes()] == ["arm", "restore"]
    guard.hass.states.async_set(PLUG, "on")  # recovers: fires again and re-arms
    await guard.hass.async_block_till_done()
    assert [w["guard_mode"] for w in guard.writes()] == ["arm", "restore", "arm"]
    guard.hass.states.async_set(PLUG, "off")  # unplugged
    await guard.hass.async_block_till_done()
    assert [w["guard_mode"] for w in guard.writes()] == ["arm", "restore", "arm", "restore"]


async def test_attribute_only_plug_update_does_not_fire(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.hass.states.async_set(PLUG, "on")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.setup(dry_run=False, plug_entities=[PLUG])
    await guard.run()
    guard.hass.states.async_set(PLUG, "on", {"battery": 50})
    await guard.hass.async_block_till_done()
    assert len(guard.writes()) == 1


# ---- P1: write action ----

async def test_missing_write_action_is_rejected_by_blueprint(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    await guard.setup(write_action=...)
    assert guard.logged("Missing input write_action")
    st = guard.hass.states.get(AUTOMATION)
    assert st is None or st.state == "unavailable"


async def test_empty_write_action_in_live_mode_stops_with_error(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(dry_run=False, write_action=[])
    await guard.run()
    assert guard.logged("the write action did not set write_verified to true")
    assert guard.helper.split(";")[2] == ""  # no verified-write marker
    await guard.run()
    assert guard.logged("Not recorded as written")  # never skipped as "already written"
    assert not guard.logged("already written and verified")


async def test_write_action_that_does_not_confirm_is_not_marked(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(dry_run=False, write_action=[WRITE_ACTION[0]])
    await guard.run()
    await guard.run()
    assert len(guard.writes()) == 2  # called, but never trusted: retried every run
    assert guard.helper.split(";")[2] == ""
    assert guard.logged("did not set write_verified to true")


async def test_empty_write_action_is_fine_in_dry_run(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(write_action=[])
    await guard.run()
    assert guard.logged("IO EV Guard dry run: would restore slot 5 start=16:00")
    assert not guard.logged("write_verified")


async def test_write_action_with_run_time_templates_still_runs(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    action = [{"repeat": {"count": 1, "sequence": [{"action": "test.write", "data": {"i": "{{ repeat.index }}", "start": "{{ start }}"}}]}}, {"variables": {"write_verified": True}}]
    await guard.setup(dry_run=False, write_action=action)
    await guard.run()
    assert guard.writes() == [{"i": 1, "start": "16:00"}]


# ---- P2: neighbour validation ----

@pytest.mark.parametrize(
    ("slot", "prev", "nxt", "msg"),
    [
        (1, "22:00", "22:00", "previous and next slot starts are a duplicate (22:00)"),
        (6, "22:00", "22:00", "previous and next slot starts are a duplicate (22:00)"),
        (1, "00:00", "00:00", "duplicate (00:00)"),
        (5, "9:00", "18:00", "previous slot start 9:00 must be HH:MM"),
        (5, "05:30", "18:0", "next slot start 18:0 must be HH:MM"),
        (5, "05:30", "24:00", "next slot start 24:00 must be HH:MM"),
        (5, "18:00", "05:30", "out of order (only slot 1 or 6 may cross midnight)"),
        (5, "05:30", "16:00", "restore start 16:00 duplicates a neighbour slot start"),
        (5, "", "18:00", "set both neighbour slot starts before turning dry run off"),
    ],
)
async def test_invalid_neighbour_config_fails_safe(guard, freezer, slot, prev, nxt, msg):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.setup(dry_run=False, guard_slot=slot, slot_prev_start=prev, slot_next_start=nxt)
    await guard.run()
    assert guard.writes() == []
    assert guard.logged(msg)
    assert guard.logged("Nothing written.")


async def test_invalid_neighbour_config_fails_safe_in_dry_run_too(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(guard_slot=6, slot_prev_start="22:00", slot_next_start="22:00")
    await guard.run()
    assert guard.logged("duplicate (22:00)")
    assert not guard.logged("would restore")


async def test_slot6_valid_wrap_still_arms(guard, freezer):
    freezer.move_to("2026-06-10 21:10:00+00:00")  # 22:10 BST
    guard.set_dispatch("on", t("2026-06-10 21:00"), t("2026-06-10 22:00"))
    await guard.setup(dry_run=False, guard_slot=6, slot_prev_start="20:00", slot_next_start="00:00", restore_start="21:00:00")
    await guard.run()
    assert guard.writes()[0]["start"] == "22:10"


# ---- P2: arm start clamp ----

async def test_restart_mid_dispatch_clamps_to_now(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")  # 14:40 BST; dispatch 14:00-15:00 BST
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.boot(dry_run=False)
    await guard.finish_boot()
    assert guard.writes()[-1]["start"] == "14:40"
    # Later triggers keep the chosen start (no creep) and skip the identical verified write.
    freezer.move_to("2026-06-10 13:50:00+00:00")
    await guard.run()
    assert len(guard.writes()) == 1


async def test_restart_reuses_stored_start_and_always_rewrites(guard, freezer):
    # Helper restored after a restart: this dispatch was armed at 14:10 and verified 10 minutes ago.
    # Without a restart this exact state is skipped (see test_identical_write_skipped_until_resync).
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.boot(dry_run=False)
    seg = int(t("2026-06-10 13:00").timestamp())
    marker = f"{seg};14:10;arm,5,14:10,1,100;{int(t('2026-06-10 13:30').timestamp())}"
    await guard.hass.services.async_call("input_text", "set_value", {"entity_id": "input_text.io_ev_guard_state", "value": marker}, blocking=True)
    await guard.finish_boot()
    assert [w["start"] for w in guard.writes()] == ["14:10"]  # same start (no creep), but rewritten after the restart


async def test_dispatch_seen_at_its_start_uses_its_start(guard, freezer):
    freezer.move_to("2026-06-10 13:00:20+00:00")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.setup(dry_run=False)
    await guard.run()
    assert guard.writes()[-1]["start"] == "14:00"


async def test_dispatch_overlapping_offpeak_end(guard, freezer):
    # Dispatch 04:00-07:00 BST overlaps the 23:30-05:30 off-peak window.
    guard.set_dispatch("on", t("2026-06-10 03:00"), t("2026-06-10 06:00"))
    freezer.move_to("2026-06-10 04:00:00+00:00")  # 05:00 BST, inside off-peak: restore
    await guard.setup(dry_run=False, slot_prev_start="05:00")
    await guard.run()
    assert guard.writes()[-1]["guard_mode"] == "restore"
    freezer.move_to("2026-06-10 04:30:00+00:00")  # 05:30 BST: off-peak ends, the extra part starts now
    await guard.run()
    assert guard.writes()[-1] == {"slot": 5, "start": "05:30", "grid_charge": True, "cap": 100, "guard_mode": "arm"}


async def test_dispatch_running_into_offpeak_start_restores(guard, freezer):
    guard.set_dispatch("on", t("2026-06-10 21:00"), t("2026-06-10 23:30"))
    freezer.move_to("2026-06-10 21:10:00+00:00")  # 22:10 BST
    await guard.setup(dry_run=False, guard_slot=6, slot_prev_start="20:00", slot_next_start="00:00", restore_start="21:00:00")
    await guard.run()
    assert guard.writes()[-1]["guard_mode"] == "arm"
    freezer.move_to("2026-06-10 22:30:00+00:00")  # 23:30 BST
    await guard.run()
    assert guard.writes()[-1]["guard_mode"] == "restore"


async def test_uk_clocks_go_back(guard, freezer):
    # 25 Oct 2026: 02:00 BST -> 01:00 GMT. Dispatch from 00:00 BST (23:00 UTC on the 24th) to 07:00 GMT.
    guard.set_dispatch("on", t("2026-10-24 23:00"), t("2026-10-25 07:00"))
    freezer.move_to("2026-10-25 06:00:00+00:00")  # 06:00 GMT, after the 05:30 GMT off-peak end
    await guard.setup(dry_run=False)
    await guard.run()
    assert guard.writes()[-1]["start"] == "06:00"


async def test_uk_clocks_go_forward(guard, freezer):
    # 29 Mar 2026: 01:00 GMT -> 02:00 BST. Dispatch 05:00-08:00 BST, first seen at 06:10 BST.
    guard.set_dispatch("on", t("2026-03-29 04:00"), t("2026-03-29 07:00"))
    freezer.move_to("2026-03-29 05:10:00+00:00")
    await guard.setup(dry_run=False)
    await guard.run()
    assert guard.writes()[-1]["start"] == "06:10"


async def test_dispatch_across_midnight_with_custom_offpeak(guard, freezer):
    # Off-peak 00:30-04:30; dispatch 23:50 BST to 00:20 BST, first seen 00:05 BST: start is 00:05, not 23:50.
    guard.set_dispatch("on", t("2026-06-10 22:50"), t("2026-06-10 23:20"))
    freezer.move_to("2026-06-10 23:05:00+00:00")
    await guard.setup(dry_run=False, guard_slot=1, slot_prev_start="22:00", slot_next_start="05:00", restore_start="00:01:00",
                      offpeak_start="00:30:00", offpeak_end="04:30:00")
    await guard.run()
    assert guard.writes()[-1]["start"] == "00:05"


# ---- redundant writes, failures, drift, outage ----

async def test_failed_write_is_not_marked_and_retried(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(dry_run=False)
    guard.fail_writes = True
    await guard.run()
    assert guard.writes() == []
    assert guard.helper.split(";")[2] == ""  # no verified-write marker
    guard.fail_writes = False
    await guard.run()
    assert len(guard.writes()) == 1  # retried, not skipped
    assert guard.helper.split(";")[2] == "restore,5,16:00,0,50"


async def test_identical_write_skipped_until_resync(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(dry_run=False, resync_hours=6)
    await guard.run()
    await guard.run()
    assert len(guard.writes()) == 1
    freezer.move_to("2026-06-10 19:40:00+00:00")  # 6 h later: rewritten in case it drifted on the inverter
    await guard.run()
    assert len(guard.writes()) == 2


async def test_resync_zero_never_skips(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("off")
    await guard.setup(dry_run=False, resync_hours=0)
    await guard.run()
    await guard.run()
    assert len(guard.writes()) == 2


async def test_dry_run_never_marks_a_write(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.setup()
    await guard.run()
    assert guard.writes() == []
    assert guard.logged("IO EV Guard dry run: would arm slot 5 start=14:40")
    k, s, w, ts = guard.helper.split(";")
    assert (s, w, ts) == ("14:40", "", "")


async def test_sensor_outage_restores_immediately_and_forgets_arm(guard, freezer):
    freezer.move_to("2026-06-10 13:40:00+00:00")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.setup(dry_run=False)
    await guard.run()
    assert guard.writes()[-1]["guard_mode"] == "arm"
    freezer.move_to("2026-06-10 13:45:00+00:00")
    guard.hass.states.async_set("binary_sensor.octopus_energy_test_intelligent_dispatching", "unavailable")
    await guard.hass.async_block_till_done()
    assert guard.writes()[-1]["guard_mode"] == "restore"
    assert guard.helper.split(";")[:2] == ["", ""]
    # Back on 5 minutes later: a fresh clamp to now, not the old stored 14:40.
    freezer.move_to("2026-06-10 13:50:00+00:00")
    guard.set_dispatch("on", t("2026-06-10 13:00"), t("2026-06-10 14:00"))
    await guard.hass.async_block_till_done()
    assert guard.writes()[-1]["start"] == "14:50"


async def test_hold_when_arm_start_out_of_slot_order(guard, freezer):
    freezer.move_to("2026-06-10 17:10:00+00:00")  # 18:10 BST, after the next slot's 18:00 start
    guard.set_dispatch("on", t("2026-06-10 17:00"), t("2026-06-10 18:00"))
    await guard.setup(dry_run=False)
    await guard.run()
    assert guard.writes() == []
    assert guard.logged("IO EV Guard hold: arm start 18:10 is out of slot order")
