from pathlib import Path

from sanctimaps_agent.adapter.state import interpret
from sanctimaps_agent.config import FORMATS, STYLES, resolve_format
from sanctimaps_agent.director import style_from_name
from sanctimaps_agent.recorder import FrameRecorder
from sanctimaps_agent.scenario import Scenario, Shot
from sanctimaps_agent.states import SiteState

BASE = {"loader": None, "hasSvg": True, "mode": "world", "transform": [0.002, 0, -260], "rafPending": 0,
        "trail": ["Monde"], "corpusIndex": 0, "ficheOpen": False, "picker": False, "section": None}


def test_state_detection():
    assert interpret({**BASE, "loader": "loading"}).state == SiteState.LOADING
    assert interpret({**BASE, "loader": "ready"}).state == SiteState.INTRO_OPEN
    assert interpret(BASE).state == SiteState.MAP_READY
    country = interpret({**BASE, "mode": "country", "trail": ["Monde", "Europe", "France"]})
    assert country.state == SiteState.COUNTRY_VIEW and country.country == "France"
    fiche = interpret({**BASE, "mode": "country", "ficheOpen": True, "ficheName": "Louis IX", "detailRows": 6})
    assert fiche.state == SiteState.SAINT_PROFILE_OPEN
    partial = interpret({**BASE, "mode": "country", "ficheOpen": True, "ficheName": "", "detailRows": 0})
    assert partial.state == SiteState.SAINT_PANEL_OPEN
    prev = interpret(BASE)
    zooming = interpret({**BASE, "transform": [0.003, 0, -260]}, prev)
    assert zooming.state == SiteState.MAP_ZOOMING
    moving = interpret({**BASE, "transform": [0.002, 40, -260]}, prev)
    assert moving.state == SiteState.MAP_MOVING
    app = interpret({**BASE, "corpusIndex": 1})
    assert app.has(SiteState.APPARITIONS_MODE)
    century = interpret({**BASE, "section": "search", "centuryToken": True})
    assert century.state == SiteState.CENTURY_VIEW


def test_formats_and_styles():
    assert FORMATS["9:16"].viewport == (1080, 1920)
    assert resolve_format("16:9", "4k").device_scale_factor == 2
    assert resolve_format("16:9", "720p").output == (1280, 720)
    slow = style_from_name("documentary-slow")
    assert slow.transition_s > STYLES["documentary"].transition_s
    fast = style_from_name("documentary@2.0")
    assert abs(fast.transition_s - STYLES["documentary"].transition_s / 2) < 1e-9


def test_trim_dead_time_only_removes_identical_wait_frames(tmp_path: Path):
    rec = FrameRecorder(tmp_path, 30)
    rec.begin("s01", "test")
    for _ in range(10):
        rec.add(b"same", "wait", "MAP_READY")
    for _ in range(10):
        rec.add(b"same", "hold", "MAP_READY")  # une pause voulue reste
    rec.add(b"other", "action", "MAP_MOVING")
    rec.end()
    removed = rec.trim_dead_time(keep_frames=4)
    assert removed == 5
    assert len(rec.segments["s01"].frames) == 16


def test_scenario_timeline_and_json():
    sc = Scenario("demande", [Shot("s01", "establish_world", duration_s=4), Shot("s02", "open_country",
                  {"country": "FRA"}, 6, "Descente vers France")], target_s=10)
    text = sc.timeline()
    assert "0.0–  4.0 s  Vue mondiale stable" in text and "Descente vers France" in text
    again = Scenario.from_dict(__import__("json").loads(sc.to_json()))
    assert again.shots[1].params == {"country": "FRA"}


def test_variants_keep_timing_consistent():
    from types import SimpleNamespace

    from sanctimaps_agent.director import Director
    from sanctimaps_agent.planner import ScenarioPlanner

    shots = [Shot("s01", "establish_world", duration_s=1.6), Shot("s02", "open_continent", {"continent": "europe"}, 1.8),
             Shot("s03", "open_country", {"country": "ITA"}, 2.0), Shot("s04", "hold", duration_s=6.6)]
    d = Director(SimpleNamespace(planner=SimpleNamespace(natural_seconds=ScenarioPlanner.natural_seconds)))
    d.scenario = Scenario("x", shots, style="documentary@1.67", target_s=12)
    slow = d.variant(slower=1.4)
    assert slow.style == "documentary@1.193"
    assert abs(slow.total_s - 12 * 1.4) < 0.05
    smooth = d.variant(smoother=True)
    assert smooth.style.startswith("cinematic")
    assert abs(smooth.total_s - 12) < 0.05
