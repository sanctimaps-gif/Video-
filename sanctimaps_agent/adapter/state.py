"""Détection de l'état de SanctiMaps à partir du DOM."""

from __future__ import annotations

from ..states import SiteState, Snapshot
from .knowledge import SNAPSHOT_JS

CORPUS_BY_INDEX = {0: "saints", 1: "apparitions", 2: "miracles"}


def interpret(raw: dict, previous: Snapshot | None = None, zoom_ratio: float | None = None) -> Snapshot:
    flags: set[SiteState] = set()
    corpus = CORPUS_BY_INDEX.get(raw.get("corpusIndex", -1))
    transform = tuple(raw["transform"]) if raw.get("transform") else None

    if raw.get("loader") == "error":
        state = SiteState.ERROR
    elif raw.get("loader") == "loading" or not raw.get("hasSvg"):
        state = SiteState.LOADING
    elif raw.get("loader") == "ready":
        state = SiteState.INTRO_OPEN
    else:
        mode = raw.get("mode")
        state = {"world": SiteState.MAP_READY, "continent": SiteState.CONTINENT_VIEW,
                 "country": SiteState.COUNTRY_VIEW}.get(mode, SiteState.UNKNOWN)
        if mode == "country" and zoom_ratio and zoom_ratio > 2.2:
            flags.add(SiteState.COUNTRY_VIEW)
            state = SiteState.PLACE_VIEW

        moving = False
        if previous and previous.transform and transform:
            k0, x0, y0 = previous.transform
            k1, x1, y1 = transform
            if k0 and abs(k1 - k0) / k0 > 1e-6:
                flags.add(SiteState.MAP_ZOOMING)
                moving = True
            elif abs(x1 - x0) > 0.5 or abs(y1 - y0) > 0.5:
                flags.add(SiteState.MAP_MOVING)
                moving = True
        if raw.get("rafPending"):
            moving = True
            flags.add(SiteState.MAP_MOVING)

        if raw.get("picker") or raw.get("activeMarker"):
            flags.add(SiteState.SAINT_SELECTED)
        if raw.get("ficheOpen"):
            complete = bool(raw.get("ficheName")) and raw.get("detailRows", 0) > 0
            flags.add(SiteState.SAINT_PROFILE_OPEN if complete else SiteState.SAINT_PANEL_OPEN)
        if raw.get("section") == "search":
            flags.add(SiteState.SEARCH_ACTIVE)
            if raw.get("centuryToken"):
                flags.add(SiteState.CENTURY_VIEW)
        if raw.get("section") == "daily":
            flags.add(SiteState.CALENDAR_VIEW)
        if corpus == "apparitions":
            flags.add(SiteState.APPARITIONS_MODE)

        # L'état principal : le plus spécifique de ce qui se voit.
        for candidate in (SiteState.MAP_ZOOMING, SiteState.MAP_MOVING) if moving else ():
            if candidate in flags:
                flags.add(state)
                state = candidate
                break
        else:
            for candidate in (SiteState.SAINT_PROFILE_OPEN, SiteState.SAINT_PANEL_OPEN,
                              SiteState.SAINT_SELECTED, SiteState.CENTURY_VIEW,
                              SiteState.CALENDAR_VIEW, SiteState.SEARCH_ACTIVE):
                if candidate in flags:
                    flags.add(state)
                    state = candidate
                    break

    return Snapshot(
        state=state, flags=flags, mode=raw.get("mode"), trail=raw.get("trail") or [],
        transform=transform, corpus=corpus, fiche_name=raw.get("ficheName"),
        hint=raw.get("hint"), panel_section=raw.get("section"), raw=raw,
    )


async def read_snapshot(page, previous: Snapshot | None = None, zoom_ratio: float | None = None) -> Snapshot:
    raw = await page.evaluate(SNAPSHOT_JS)
    return interpret(raw, previous, zoom_ratio)
