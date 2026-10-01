import pytest

from sanctimaps_agent.studio_format import extract_json, from_studio

BODY = """Rendu demandé depuis le studio.

```json
{"request": "France", "style": "documentary", "speed": 1.4, "aspect": "9:16",
 "shots": [{"id": "s01", "action": "establish_world", "params": {}, "duration": 3, "label": "Vue mondiale stable"},
           {"id": "s02", "action": "zoom_to_place", "params": {"place": "@tour:0", "resolvedPlace": "Paris", "country": "FRA"}, "duration": 6},
           {"id": "s03", "action": "open_saint", "params": {"query": "@interesting", "resolved": "Jeanne d'Arc", "place": null}, "duration": 5}]}
```
"""


def test_issue_body_to_scenario():
    sc = from_studio(extract_json(BODY))
    assert sc.aspect == "9:16" and sc.style == "documentary@1.400"
    assert [s.action for s in sc.shots] == ["establish_world", "zoom_to_place", "open_saint"]
    assert sc.shots[1].params == {"place": "@tour:0", "resolved_place": "Paris", "country": "FRA"}
    assert "place" not in sc.shots[2].params
    assert sc.total_s == 14


def test_rejects_unknown_action_and_absurd_durations():
    with pytest.raises(ValueError):
        from_studio({"shots": [{"action": "rm -rf", "duration": 3}]})
    with pytest.raises(ValueError):
        from_studio({"shots": [{"action": "hold", "duration": 9999}]})
    with pytest.raises(ValueError):
        from_studio({"shots": []})


def test_new_studio_actions_are_accepted():
    sc = from_studio({"shots": [
        {"action": "level_up", "duration": 3}, {"action": "miracles_on", "duration": 1},
        {"action": "show_lieux", "duration": 4}, {"action": "show_croises", "duration": 4},
        {"action": "search_list", "params": {"query": "Lyon"}, "duration": 3},
        {"action": "close_panel", "duration": 1}, {"action": "open_marker", "duration": 3},
        {"action": "frame_view", "params": {"x": 506524, "y": 344042, "ratio": 3.5, "country": "FRA", "near": "Paris"}, "duration": 5},
        {"action": "pan", "params": {"direction": "north", "fraction": 0.5}, "duration": 2},
    ]})
    assert len(sc.shots) == 9 and sc.shots[7].params["ratio"] == 3.5
