"""Tests de bout en bout contre un SanctiMaps réel ou local.

    SANCTIMAPS_TEST_URL=https://sanctimaps.fr/ pytest tests/test_integration.py
    # ou, sur une copie locale du site : (cd sanctimaps && npm start)
    SANCTIMAPS_TEST_URL=http://127.0.0.1:8080/ pytest tests/test_integration.py
"""

import os

import pytest

from sanctimaps_agent.agent import SanctiMapsVideoAgent
from sanctimaps_agent.config import AgentConfig
from sanctimaps_agent.states import SiteState

URL = os.environ.get("SANCTIMAPS_TEST_URL")
pytestmark = pytest.mark.skipif(not URL, reason="SANCTIMAPS_TEST_URL non défini")


@pytest.mark.asyncio
async def test_navigation_commands(tmp_path):
    agent = SanctiMapsVideoAgent(AgentConfig(url=URL, work_dir=str(tmp_path), vision_enabled=False,
                                             llm_planner_enabled=False), style="fast")
    try:
        await agent.open()
        assert (await agent.adapter.state()).state == SiteState.MAP_READY
        out = await agent.handle("Va en France.")
        assert out.startswith("✓") and agent.memory.selected_country == "FRA"
        out = await agent.handle("Zoome sur Paris.")
        assert out.startswith("✓") and agent.memory.selected_place == "Paris"
        out = await agent.handle("Cherche saint Louis.")
        assert out.startswith("✓")
        assert (await agent.adapter.state()).has(SiteState.SAINT_PROFILE_OPEN)
        out = await agent.handle("Montre-moi les saints du XIIe siècle.")
        assert out.startswith("✓")
        out = await agent.handle("Passe en mode apparitions.")
        assert out.startswith("✓") and agent.memory.current_mode == "apparitions"
    finally:
        await agent.close()


@pytest.mark.asyncio
async def test_director_short_video(tmp_path):
    agent = SanctiMapsVideoAgent(AgentConfig(url=URL, work_dir=str(tmp_path), vision_enabled=False,
                                             llm_planner_enabled=False), style="fast")
    try:
        result = await agent.director.make("Fais une vidéo rapide de 12 secondes : le monde puis l'Italie.")
        assert result.video and result.video.exists()
        assert all(r.ok for r in result.reports.values())
    finally:
        await agent.close()
