import pytest

from sanctimaps_agent.planner import ScenarioPlanner
from sanctimaps_agent.session import SessionMemory

EX_45 = ("Fais une vidéo de 45 secondes qui commence avec une vue du monde, descend progressivement vers la "
         "France, puis Paris, affiche la fiche du saint sélectionné et revient progressivement à une vue de la France.")
EX_60 = ("Crée une vidéo verticale de 60 secondes présentant les saints de France. Commence par le monde, "
         "rapproche-toi progressivement de la France, montre plusieurs zones puis termine avec une fiche intéressante.")


def planner(site, corpus):
    return ScenarioPlanner(site, corpus, SessionMemory(), use_llm=False)


@pytest.mark.asyncio
async def test_example_45s(site, corpus):
    sc = await planner(site, corpus).plan(EX_45)
    actions = [s.action for s in sc.shots]
    assert actions[:4] == ["establish_world", "open_continent", "open_country", "zoom_to_place"]
    assert sc.shots[3].params["place"] == "Paris"
    assert "show_profile" in actions
    assert actions.index("fit_country") > actions.index("show_profile")
    assert sc.aspect == "16:9"
    assert abs(sc.total_s - 45) < 0.1


@pytest.mark.asyncio
async def test_example_vertical_60s(site, corpus):
    sc = await planner(site, corpus).plan(EX_60)
    actions = [s.action for s in sc.shots]
    assert sc.aspect == "9:16"
    assert actions.count("open_country") == 1, "la phrase d'annonce ne doit pas dupliquer la descente"
    assert actions.count("pan_to_place") == 2
    assert actions[-2:] == ["open_saint", "show_profile"]
    assert sc.shots[-2].params["query"] == "@interesting"
    assert abs(sc.total_s - 60) < 0.1


@pytest.mark.asyncio
async def test_france_30s_matches_spec_shape(site, corpus):
    sc = await planner(site, corpus).plan("Fais-moi une vidéo de 30 secondes sur les saints en France.")
    actions = [s.action for s in sc.shots]
    assert actions[:3] == ["establish_world", "open_continent", "open_country"]
    assert actions[-2:] == ["fit_country", "hold"]


@pytest.mark.asyncio
async def test_apparitions_and_century(site, corpus):
    sc = await planner(site, corpus).plan(
        "Une vidéo cinématique de 40 secondes : les saints du XIIe siècle en Italie, puis passe en mode "
        "apparitions et montre Lourdes.")
    actions = [s.action for s in sc.shots]
    assert sc.style == "cinematic"
    century = next(s for s in sc.shots if s.action == "century_filter")
    assert century.params == {"century": 12, "country": "ITA"}
    assert actions.index("apparitions_on") < actions.index("open_apparition")
    assert next(s for s in sc.shots if s.action == "open_apparition").params["name"] == "Lourdes"


@pytest.mark.asyncio
async def test_fits_short_duration_by_speeding_up(site, corpus):
    sc = await planner(site, corpus).plan(
        "vidéo de 12 secondes : monde, France, Paris, fiche de saint Denis, retour à la France")
    assert abs(sc.total_s - 12) < 0.1
    assert "@" in sc.style
