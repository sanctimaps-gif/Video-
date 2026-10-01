"""Synchronisation intelligente : on attend un état, pas une durée.

Aucune de ces fonctions ne dort « au cas où » : chacune interroge la page à
chaque pas et rend la main dès que la condition est réellement remplie, ou
lève ``SyncTimeout`` avec ce qu'elle a vu.
"""

from __future__ import annotations

import time
from typing import Awaitable, Callable

from .adapter.state import read_snapshot
from .stage import Stage
from .states import SiteState, Snapshot


class SyncTimeout(TimeoutError):
    def __init__(self, what: str, last: object = None):
        super().__init__(f"Délai dépassé en attendant : {what} (dernier état : {last})")
        self.what = what
        self.last = last


class Synchronizer:
    def __init__(self, page, stage: Stage, default_timeout_s: float = 15.0):
        self.page = page
        self.stage = stage
        self.default_timeout_s = default_timeout_s
        self.last: Snapshot | None = None

    async def snapshot(self) -> Snapshot:
        self.last = await read_snapshot(self.page, self.last)
        self.stage.state_label = self.last.state.value
        return self.last

    async def wait_for(self, what: str, predicate: Callable[[], Awaitable[bool]],
                       timeout_s: float | None = None, max_frames: int | None = None) -> None:
        """Attend ``predicate`` en temps réel *et* en images (pour ne pas filmer une éternité)."""
        deadline = time.monotonic() + (timeout_s or self.default_timeout_s)
        frames = 0
        while True:
            if await predicate():
                return
            if time.monotonic() > deadline or (max_frames and frames >= max_frames):
                raise SyncTimeout(what, self.last.state if self.last else None)
            await self.stage.poll_step()
            frames += 1

    # ------------------------------------------------------------------ page

    async def wait_until_page_ready(self, timeout_s: float = 60.0) -> Snapshot:
        await self.page.wait_for_load_state("domcontentloaded", timeout=timeout_s * 1000)

        async def ready() -> bool:
            snap = await self.snapshot()
            if snap.state == SiteState.ERROR:
                raise RuntimeError(f"SanctiMaps signale une erreur de chargement : {snap.raw.get('loaderText')}")
            return snap.state not in (SiteState.LOADING, SiteState.UNKNOWN)

        await self.wait_for("chargement de la carte", ready, timeout_s)
        return self.last

    # ------------------------------------------------------------------ carte

    async def wait_until_animation_finished(self, timeout_s: float | None = None) -> None:
        async def done() -> bool:
            return not (await self.snapshot()).raw.get("rafPending")

        await self.wait_for("fin d'animation", done, timeout_s)

    async def wait_until_map_stable(self, stable_frames: int = 3, timeout_s: float | None = None,
                                    wait_tiles: bool = True) -> Snapshot:
        """Carte immobile : plus d'animation en file, transformation identique
        sur ``stable_frames`` pas consécutifs, tuiles de fond chargées."""
        streak = 0
        previous: tuple | None = None

        async def stable() -> bool:
            nonlocal streak, previous
            snap = await self.snapshot()
            same = snap.transform is not None and snap.transform == previous
            previous = snap.transform
            quiet = not snap.raw.get("rafPending") and (not wait_tiles or not snap.raw.get("tilesLoading"))
            streak = streak + 1 if (same and quiet) else 0
            return streak >= stable_frames

        await self.wait_for("carte stable", stable, timeout_s)
        return self.last

    # ---------------------------------------------------------------- panneaux

    async def wait_until_panel_open(self, timeout_s: float | None = None) -> Snapshot:
        """La fiche est ouverte *et* remplie (nom, lignes de la fiche)."""
        async def complete() -> bool:
            return (await self.snapshot()).has(SiteState.SAINT_PROFILE_OPEN)

        await self.wait_for("fiche complète", complete, timeout_s)
        return self.last

    async def wait_until_panel_closed(self, timeout_s: float | None = None) -> None:
        async def closed() -> bool:
            snap = await self.snapshot()
            return not snap.raw.get("ficheOpen")

        await self.wait_for("fiche fermée", closed, timeout_s)

    async def wait_until_search_results(self, previous_summary: str | None = None,
                                        timeout_s: float | None = None) -> str:
        summary = {"text": ""}

        async def updated() -> bool:
            text = await self.page.evaluate(
                "() => (document.querySelector('.search .results__summary') || {}).textContent || ''")
            summary["text"] = text
            return bool(text) and text != previous_summary

        await self.wait_for("résultats de recherche", updated, timeout_s)
        return summary["text"]
