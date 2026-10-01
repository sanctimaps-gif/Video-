"""Exécution d'un plan : action → vérification → autre méthode → vision → correction.

Chaque plan a une liste de méthodes, de la plus directe à la plus robuste. La
première qui aboutit *et se vérifie* l'emporte. Le nombre d'essais est borné.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from .adapter.apparitions import ApparitionsController
from .adapter.sanctimaps import ActionReport, SanctiMapsAdapter
from .adapter.site_data import fold
from .scenario import Shot

log = logging.getLogger(__name__)

Method = Callable[[], Awaitable[ActionReport]]


async def resilient(name: str, methods: list[Method], max_attempts: int = 3) -> ActionReport:
    last: ActionReport | None = None
    attempts = 0
    for method in methods:
        if attempts >= max_attempts:
            break
        attempts += 1
        try:
            last = await method()
        except Exception as exc:  # noqa: BLE001 - toute erreur est un échec de cette méthode
            log.warning("%s : méthode %d en échec (%s)", name, attempts, exc)
            last = ActionReport(name, False, f"{type(exc).__name__}: {exc}")
            continue
        if last and last.ok:
            last.attempts = attempts
            return last
        log.info("%s : vérification négative (%s), méthode suivante", name, last.detail if last else "")
    if last is None:
        last = ActionReport(name, False, "aucune méthode disponible")
    last.attempts = attempts
    return last


class ShotExecutor:
    def __init__(self, adapter: SanctiMapsAdapter, max_attempts: int = 3):
        self.a = adapter
        self.app = ApparitionsController(adapter)
        self.max_attempts = max_attempts

    # ------------------------------------------------------ résolution

    async def resolve(self, shot: Shot) -> None:
        """Fixe les choix laissés ouverts par le scénario (quel saint, quelles zones)."""
        p = shot.params
        if p.get("query") == "@interesting" and not p.get("resolved"):
            candidates = []
            place, iso = p.get("place"), p.get("country") or self.a.memory.selected_country
            if place:
                found = await self.a.corpus.city_country(place)
                if found:
                    texts = await self.a.corpus.texts()
                    from .adapter.site_data import _richness
                    candidates = sorted(found[1], key=lambda s: -_richness(s, texts))
            if not candidates:
                candidates = await self.a.corpus.interesting(iso, limit=5)
            if candidates:
                name = candidates[0]["name"]
                p["resolved"] = name.get("fr") if isinstance(name, dict) else name
        place = p.get("place")
        if isinstance(place, str) and place.startswith("@tour:") and not p.get("resolved_place"):
            iso = p.get("country") or self.a.memory.selected_country
            tour = await self.tour_places(iso)
            idx = int(place.split(":")[1])
            if idx < len(tour):
                p["resolved_place"] = tour[idx]

    async def tour_places(self, iso: str | None, n: int = 3) -> list[str]:
        """Les villes les plus riches en saints du pays, assez éloignées l'une de l'autre."""
        if not iso:
            return []
        counts: dict[str, int] = {}
        for saint in await self.a.corpus.saints():
            if saint.get("country") == iso:
                counts[saint["city"]] = counts.get(saint["city"], 0) + 1
        chosen: list[dict] = []
        for city_name, _ in sorted(counts.items(), key=lambda kv: -kv[1]):
            city = await self.a.site.find_place(city_name, iso)
            if not city:
                continue
            bbox = self.a.site.country_by_id[iso]["focus"]
            span = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
            if all(abs(city["x"] - c["x"]) + abs(city["y"] - c["y"]) > span * 0.25 for c in chosen):
                chosen.append(city)
            if len(chosen) >= n:
                break
        return [c["n"] for c in chosen]

    # ---------------------------------------------------------- exécution

    async def run(self, shot: Shot) -> ActionReport:
        await self.resolve(shot)
        p = shot.params
        a = self.a
        act = shot.action

        if act == "establish_world":
            async def world():
                snap = await a.state()
                if snap.raw.get("ficheOpen"):
                    await a.close_profile()
                if snap.mode != "world":
                    return await a.go_world()
                return ActionReport("establish_world", True, "vue mondiale")
            return await resilient(act, [world, a.go_world], self.max_attempts)

        if act == "back_to_world":
            async def back():
                await a.close_profile()
                return await a.go_world()
            return await resilient(act, [back, back], self.max_attempts)

        if act == "open_continent":
            cid = p["continent"]
            async def retry_from_world():
                await a.go_world()
                return await a.go_continent(cid)
            return await resilient(act, [lambda: a.go_continent(cid), retry_from_world], self.max_attempts)

        if act == "open_country":
            iso = p["country"]
            async def retry_from_world():
                await a.close_profile()
                await a.go_world()
                return await a.go_to_country(iso)
            return await resilient(act, [lambda: a.go_to_country(iso), retry_from_world], self.max_attempts)

        if act in ("zoom_to_place", "pan_to_place"):
            place = p.get("resolved_place") or p.get("place")
            if not place or place.startswith("@"):
                return ActionReport(act, False, "aucun lieu à montrer")
            ratio = p.get("ratio")
            if act == "pan_to_place":
                async def pan_only():
                    loc = await a.locate_place(place, p.get("country"))
                    if not loc:
                        return ActionReport(act, False, f"{place} introuvable")
                    if a.memory.selected_country != loc["iso"]:
                        return await a.go_to_place(place, loc["iso"], ratio)
                    move = await a.map.pan_to_projected(loc["x"], loc["y"])
                    a.memory.selected_place = loc["name"]
                    return ActionReport(act, move.ok or move.achieved > 0, f"{loc['name']} ({loc['kind']})", loc)
                return await resilient(act, [pan_only, lambda: a.go_to_place(place, p.get("country"), ratio)],
                                       self.max_attempts)
            return await resilient(act, [lambda: a.go_to_place(place, p.get("country"), ratio),
                                         lambda: a.go_to_place(place, None, ratio)], self.max_attempts)

        if act == "zoom_in":
            return await self._zoom(p.get("factor", 2.0))
        if act == "zoom_out":
            return await self._zoom(1 / p.get("factor", 2.0))

        if act == "pan":
            move = await a.map.pan(p.get("direction", "east"), p.get("fraction", 0.3))
            return ActionReport(act, move.ok, move.note)

        if act == "fit_country":
            async def fit():
                await a.close_profile()
                iso = p.get("country") or a.memory.selected_country
                snap = await a.state()
                if iso and snap.country != a.site.country_name(iso):
                    return await a.go_to_country(iso)
                await a.map.fit()
                ratio = await a.map.zoom_ratio()
                return ActionReport(act, ratio is not None and ratio < 1.15, f"zoom ×{ratio or 0:.2f}")
            async def via_country():
                return await a.go_to_country(p.get("country") or a.memory.selected_country or "")
            return await resilient(act, [fit, via_country], self.max_attempts)

        if act in ("open_saint", "open_marker"):
            query = p.get("resolved") or p.get("query")
            if act == "open_marker" or not query or query.startswith("@"):
                return await resilient(act, [a.open_cluster_near_center], self.max_attempts)
            async def from_list():
                rows = await a.visible_list()
                if not any(fold(r["name"]) == fold(query) for r in rows):
                    return ActionReport("open_saint", False, "pas dans la liste affichée")
                return await a.open_from_list(name=query)
            # Le chemin le plus court : la liste déjà ouverte, la croix visible, puis la recherche.
            return await resilient(act, [from_list, lambda: self.open_saint_on_map(query),
                                         lambda: a.search_saint(query),
                                         lambda: a.search_saint(query.split()[0])], self.max_attempts + 1)

        if act == "show_profile":
            return await resilient(act, [lambda: a.show_profile(max(1.0, shot.duration_s * 0.8))], 1)

        if act == "close_profile":
            return await a.close_profile()

        if act == "century_filter":
            century = p["century"]
            country = a.site.country_name(p["country"]) if p.get("country") else None
            rep = await resilient(act, [lambda: a.filter_by_century(century, country),
                                        lambda: a.filter_by_century(century)], self.max_attempts)
            if rep.ok:
                await a.stage.hold(0.6)
            return rep

        if act == "calendar":
            return await resilient(act, [lambda: a.select_feast_day(p.get("day", "aujourd'hui"))], self.max_attempts)

        if act == "apparitions_on":
            return await resilient(act, [self.app.enable_apparitions_mode], self.max_attempts)
        if act == "apparitions_off":
            return await resilient(act, [self.app.disable_apparitions_mode], self.max_attempts)
        if act == "open_apparition":
            return await resilient(act, [lambda: self.app.select_apparition(p.get("name"))], self.max_attempts)

        if act == "open_list_item":
            idx = p.get("index")
            return await resilient(act, [lambda: a.open_from_list(p.get("name"), idx if isinstance(idx, int) else None),
                                         lambda: a.search_saint(p["name"]) if p.get("name") else a.open_from_list(None, idx)],
                                   self.max_attempts)
        if act == "level_up":
            return await resilient(act, [a.level_up], self.max_attempts)
        if act == "miracles_on":
            return await resilient(act, [lambda: a.set_corpus("miracles")], self.max_attempts)
        if act in ("show_lieux", "show_croises"):
            return await resilient(act, [lambda: a.fiche_button(act.split("_")[1])], 1)
        if act == "search_list":
            return await resilient(act, [lambda: a.search_list(p.get("query", ""))], self.max_attempts)
        if act == "close_panel":
            await a.close_sidebar()
            return ActionReport(act, True)
        if act == "frame_view":
            return await resilient(act, [lambda: a.frame_view(float(p["x"]), float(p["y"]), float(p.get("ratio") or 1),
                                                              p.get("country"))], self.max_attempts)

        if act == "hold":
            return ActionReport("hold", True)

        return ActionReport(act, False, "action non prise en charge")

    async def _zoom(self, factor: float) -> ActionReport:
        a = self.a
        snap = await a.state()
        if snap.mode == "world":
            if factor > 1:
                return ActionReport("zoom", False, "au niveau monde, on descend en choisissant un continent")
            return ActionReport("zoom", True, "déjà au plus loin")
        move = await a.map.wheel_zoom(factor)
        if factor < 1 and not move.ok and snap.mode == "country":
            # Plus de recul possible dans le pays : on remonte d'un niveau.
            crumb = a.page.locator(".trail .crumb").nth(1)
            await a.map.site_transition(lambda: crumb.click())
            return ActionReport("zoom", True, "remontée au continent")
        return ActionReport("zoom", move.ok, f"×{move.achieved:.2f} {move.note}".strip())

    async def open_saint_on_map(self, name: str) -> ActionReport:
        """Si la croix du saint est visible sur la carte, on la touche (plus beau qu'une recherche)."""
        a = self.a
        pt = await a.page.evaluate(
            """(n) => { const norm = (s) => s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().trim();
              const h = document.querySelector('#map-host').getBoundingClientRect();
              for (const m of document.querySelectorAll('.overlay [data-cluster]')) {
                if (m.classList.contains('is-crowded')) continue;
                const l = m.querySelector('.marker__label');
                if (!l || norm(l.textContent) !== norm(n)) continue;
                const r = (m.querySelector('.marker__badge, .marker__ring, circle')).getBoundingClientRect();
                const x = r.left + r.width / 2, y = r.top + r.height / 2;
                if (x > h.left + 10 && x < h.right - 10 && y > h.top + 60 && y < h.bottom - 10) return [x, y];
              } return null; }""", name)
        if not pt:
            return ActionReport("open_saint", False, "croix non visible sur la carte")
        await a.page.mouse.move(pt[0], pt[1], steps=6)
        await a.stage.hold(0.3)
        await a.page.mouse.click(pt[0], pt[1])
        await a.sync.wait_until_panel_open()
        await a.map.stabilize()
        snap = await a.state()
        ok = fold(snap.fiche_name or "") == fold(name)
        if ok:
            a.memory.selected_saint = snap.fiche_name
        return ActionReport("open_saint", ok, f"fiche « {snap.fiche_name} » (depuis la carte)")
