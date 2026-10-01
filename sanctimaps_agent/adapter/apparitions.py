"""ApparitionsController : la bascule « Apparitions » de SanctiMaps."""

from __future__ import annotations

from .sanctimaps import ActionReport, SanctiMapsAdapter
from .site_data import fold


class ApparitionsController:
    def __init__(self, adapter: SanctiMapsAdapter):
        self.a = adapter

    async def enable_apparitions_mode(self) -> ActionReport:
        return await self.a.set_corpus("apparitions")

    async def disable_apparitions_mode(self) -> ActionReport:
        return await self.a.set_corpus("saints")

    async def select_apparition(self, name: str | None = None) -> ActionReport:
        """Ouvre une apparition par la recherche du site (portée « Apparitions »).

        Sans nom : l'apparition la plus proche du centre de la carte.
        """
        if not name:
            if self.a.memory.current_mode != "apparitions":
                await self.enable_apparitions_mode()
            return await self.a.open_cluster_near_center()
        results = await self.a.search(name, scope="apparitions")
        if not results:
            return ActionReport("select_apparition", False, f"aucune apparition pour « {name} »")
        chosen = max(results, key=lambda r: self.a.score_result(name, r))
        rep = await self.a._open_result(chosen)
        await self.a.close_sidebar()
        rep.action = "select_apparition"
        return rep

    async def open_apparition_details(self) -> ActionReport:
        """Lit la fiche d'apparition telle que le site la présente — rien d'ajouté."""
        profile = await self.a.read_profile()
        if not profile:
            return ActionReport("open_apparition_details", False, "aucune fiche ouverte")
        f = profile["fields"]
        summary = ", ".join(f"{k}: {v}" for k, v in f.items() if v)
        ok = "approval" in f or "year" in f or fold("apparition") in fold(profile.get("description") or "")
        return ActionReport("open_apparition_details", True if profile.get("title") else ok, summary, {"profile": profile})
