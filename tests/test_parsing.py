import datetime as dt

import pytest

from sanctimaps_agent.adapter.sanctimaps import SanctiMapsAdapter, roman
from sanctimaps_agent.adapter.site_data import fold
from sanctimaps_agent.nlu import parse_command
from sanctimaps_agent.planner import (parse_aspect, parse_century, parse_duration, parse_resolution,
                                      parse_style, split_clauses)
from sanctimaps_agent.projection import project, to_screen, unproject


@pytest.mark.parametrize("text,expected", [
    ("Fais une vidéo de 45 secondes", 45), ("une vidéo de 30 s", 30), ("vidéo de 1 min", 60),
    ("Crée une vidéo de 60 secondes", 60), ("une minute sur l'Italie", 60), ("sans durée", None),
])
def test_duration(text, expected):
    assert parse_duration(text) == expected


def test_aspect_resolution_style():
    assert parse_aspect("Crée une vidéo verticale") == "9:16"
    assert parse_aspect("version carrée pour Instagram") == "1:1"
    assert parse_aspect("une vidéo") is None
    assert parse_resolution("en 4K") == "4k"
    assert parse_resolution("en 720p") == "720p"
    assert parse_style("une vidéo cinématique") == "cinematic"
    assert parse_style("plus lente") == "slow"
    assert parse_style("pédagogique") == "educational"


@pytest.mark.parametrize("text,expected", [
    ("les saints du XIIe siècle", 12), ("au 13e siècle", 13), ("du IVe siecle", 4), ("en 1200", None),
])
def test_century(text, expected):
    assert parse_century(text) == expected


def test_split_clauses_keeps_order():
    parts = split_clauses("commence avec une vue du monde, descend vers la France, puis Paris, "
                          "affiche la fiche et revient à une vue de la France.")
    assert parts[0].startswith("commence")
    assert any("Paris" in p for p in parts)
    assert parts[-1].startswith("revient")


@pytest.mark.parametrize("text,intent", [
    ("Ouvre SanctiMaps.", "open"),
    ("Va en France.", "go"),
    ("Zoome sur Paris.", "zoom_place"),
    ("Montre les saints de France.", "go"),
    ("Cherche saint Louis.", "search"),
    ("Ouvre sa fiche.", "open_profile"),
    ("Fais un zoom arrière.", "zoom_out"),
    ("Maintenant zoome davantage", "zoom_in"),
    ("Montre-moi les saints du XIIe siècle.", "century"),
    ("Ouvre le calendrier.", "calendar"),
    ("Montre les saints fêtés aujourd'hui.", "calendar"),
    ("Passe en mode apparitions.", "apparitions_on"),
    ("Fais une vidéo de 30 secondes.", "video"),
    ("Fais-la plus lente.", "redo_slower"),
    ("Fais une version verticale.", "redo_aspect"),
    ("Recommence uniquement la dernière séquence.", "redo_last"),
    ("Refais la vidéo avec des mouvements plus fluides.", "redo_smoother"),
])
def test_commands_from_spec(text, intent):
    assert parse_command(text).intent == intent


def test_command_arguments():
    assert parse_command("Va en France.").args["target"] == "France"
    assert parse_command("Zoome sur Paris.").args["target"] == "Paris"
    assert parse_command("Montre les saints de France.").args["target"] == "France"
    assert parse_command("Cherche saint Louis.").args["query"] == "saint Louis"
    assert parse_command("Montre-moi les saints du XIIe siècle.").args["century"] == 12
    assert parse_command("Montre les saints fêtés aujourd'hui.").args["day"] == "aujourd'hui"
    assert parse_command("Fais une version verticale.").args["aspect"] == "9:16"


def test_projection_roundtrip():
    x, y = project(2.35, 48.85)  # Paris
    lon, lat = unproject(x, y)
    assert abs(lon - 2.35) < 1e-9 and abs(lat - 48.85) < 1e-9
    assert to_screen((100, 200), (2.0, 10, 20)) == (210, 420)


def test_result_scoring_prefers_exact_name():
    results = [{"name": "Louis Aleman"}, {"name": "Louis"}, {"name": "Jean-Louis Bonnard"}]
    best = max(results, key=lambda r: SanctiMapsAdapter.score_result("saint Louis", r))
    assert best["name"] == "Louis"


def test_parse_day():
    today = dt.date(2026, 9, 30)
    assert SanctiMapsAdapter.parse_day("aujourd'hui", today) == today
    assert SanctiMapsAdapter.parse_day("4 septembre", today) == dt.date(2026, 9, 4)
    assert SanctiMapsAdapter.parse_day("1er novembre", today) == dt.date(2026, 11, 1)
    assert SanctiMapsAdapter.parse_day("demain", today) == dt.date(2026, 10, 1)


def test_roman_and_fold():
    assert roman(12) == "XII" and roman(4) == "IV" and roman(19) == "XIX"
    assert fold("Saint-Étienne") == "saint etienne"
