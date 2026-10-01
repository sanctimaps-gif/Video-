"""SanctiMapsAdapter : naviguer dans SanctiMaps comme quelqu'un qui le connaît.

Chaque action suit le même schéma : agir comme un lecteur (clic, saisie,
molette), attendre un *état* du site, puis vérifier que l'état obtenu est
celui demandé. Un clic n'est jamais supposé réussi.
"""

from __future__ import annotations

import datetime as dt
import logging
import math
import re
from dataclasses import dataclass, field

from ..config import AgentConfig, MotionStyle
from ..session import SessionMemory
from ..stage import Stage
from ..states import SiteState, Snapshot
from ..sync import SyncTimeout, Synchronizer
from ..vision import VisionAnalyzer
from .knowledge import COUNTRY_POINT_JS, PROFILE_JS, SANCTIMAPS_ADAPTER
from .map_controller import MapController
from .site_data import CorpusData, SiteData, fold

log = logging.getLogger(__name__)

MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
             "septembre", "octobre", "novembre", "décembre"]


class ActionFailed(RuntimeError):
    pass


@dataclass
class ActionReport:
    action: str
    ok: bool
    detail: str = ""
    data: dict = field(default_factory=dict)
    attempts: int = 1

    def __str__(self) -> str:
        return f"{'✓' if self.ok else '✗'} {self.action}" + (f" — {self.detail}" if self.detail else "")


def roman(n: int) -> str:
    vals = [(10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
    out = ""
    for v, s in vals:
        while n >= v:
            out, n = out + s, n - v
    return out


class SanctiMapsAdapter:
    def __init__(self, page, stage: Stage, config: AgentConfig, style: MotionStyle,
                 memory: SessionMemory | None = None, vision: VisionAnalyzer | None = None):
        self.page = page
        self.stage = stage
        self.config = config
        self.style = style
        self.memory = memory or SessionMemory()
        self.sync = Synchronizer(page, stage, config.action_timeout_s)
        self.map = MapController(page, stage, self.sync, style)
        self.site = SiteData(page, SANCTIMAPS_ADAPTER["data_base"])
        self.corpus = CorpusData(self.site)
        self.vision = vision
        self.console_errors: list[str] = []
        self.failed_requests: list[str] = []
        page.on("console", lambda m: m.type == "error" and self.console_errors.append(m.text[:300]))
        page.on("requestfailed", lambda r: self.failed_requests.append(f"{r.url} {r.failure}"))

    def set_style(self, style: MotionStyle) -> None:
        self.style = style
        self.map.style = style

    # ================================================================ état

    async def state(self) -> Snapshot:
        snap = await self.sync.snapshot()
        ratio = await self.map.zoom_ratio() if snap.mode == "country" else None
        if ratio and ratio > 2.2 and snap.state == SiteState.COUNTRY_VIEW:
            snap.flags.add(SiteState.COUNTRY_VIEW)
            snap.state = SiteState.PLACE_VIEW
        self.memory.current_map_state = snap.state.value
        self.memory.current_view = snap.mode
        self.memory.current_zoom = ratio
        if snap.corpus:
            self.memory.current_mode = snap.corpus
        return snap

    # ========================================================== initialisation

    async def open(self) -> ActionReport:
        """Ouvre SanctiMaps et amène la carte à l'état MAP_READY."""
        self.memory.current_url = self.config.url
        await self.page.goto(self.config.url, wait_until="domcontentloaded",
                             timeout=self.config.load_timeout_s * 1000)
        try:
            await self.page.wait_for_function(
                "() => document.readyState !== 'loading' && !!document.querySelector('#map-host')",
                timeout=self.config.load_timeout_s * 1000)
            await self.page.wait_for_function(
                "() => { const l = document.querySelector('#loader'); return !l || l.classList.contains('is-ready') || l.classList.contains('is-error'); }",
                timeout=self.config.load_timeout_s * 1000)
        except Exception as exc:  # noqa: BLE001
            diagnosis = await self.diagnose()
            raise ActionFailed(f"La carte ne s'est pas chargée : {diagnosis}") from exc
        snap = await self.sync.snapshot()
        if snap.state == SiteState.ERROR:
            raise ActionFailed(f"SanctiMaps affiche une erreur : {await self.diagnose()}")
        await self.site.load()
        await self.close_intro()
        await self.close_sidebar()
        # Temps des animations sous contrôle de l'agent à partir d'ici.
        await self.stage.browser.set_manual_time(True)
        snap = await self.map.sync.wait_until_map_stable()
        self.map.base_k = snap.transform[0] if snap.transform else None
        await self.map.stabilize()
        missing = await self.check_profile()
        await self.park_mouse()
        snap = await self.state()
        if snap.state != SiteState.MAP_READY:
            raise ActionFailed(f"État inattendu après l'ouverture : {snap.state}")
        self.memory.record("open")
        g = await self.map.geometry()
        return ActionReport("open", True, f"carte {int(g['width'])}×{int(g['height'])} px",
                            {"missing_selectors": missing, "map_rect": g})

    async def park_mouse(self) -> None:
        """Souris posée sur une zone neutre de la carte : pas de survol parasite à l'image."""
        x, y = await self.map.safe_point()
        await self.page.mouse.move(x, y)

    async def close_intro(self) -> None:
        if await self.page.locator("#loader").count() == 0:
            return
        for sel in SANCTIMAPS_ADAPTER["selectors"]["loader_close"]:
            btn = self.page.locator(sel)
            if await btn.count() and await btn.first.is_visible():
                await btn.first.click()
                break
        else:
            await self.page.keyboard.press("Escape")
        await self.page.wait_for_selector("#loader", state="detached", timeout=5000)

    async def close_sidebar(self) -> None:
        panel_open = await self.page.evaluate("() => !!document.querySelector('#panel.is-open')")
        if panel_open:
            await self.page.locator(".panel__close").click()
            await self.page.wait_for_function("() => !document.querySelector('#panel.is-open')")
            await self._settle_layout()
            await self.park_mouse()

    async def _settle_layout(self) -> None:
        """Le panneau et la fiche redimensionnent la carte : on laisse le site recadrer."""
        for _ in range(3):
            await self.stage.poll_step()

    async def check_profile(self) -> list[str]:
        """Vérifie que les repères connus du site existent encore."""
        sel = SANCTIMAPS_ADAPTER["selectors"]
        missing = []
        for key in ("map_host", "map_svg", "scene", "trail"):
            candidates = sel[key]
            found = False
            for candidate in candidates:
                if await self.page.locator(candidate).count():
                    found = True
                    break
            if not found:
                missing.append(key)
        if missing:
            log.warning("Le site a changé : repères introuvables %s", missing)
        return missing

    async def diagnose(self) -> str:
        """Pourquoi la carte n'est pas là — au lieu de cliquer au hasard."""
        parts = []
        try:
            raw = await self.page.evaluate(
                "() => ({title: document.title, loader: document.querySelector('#loader')?.className,"
                " text: document.querySelector('#loader-text')?.textContent, svg: !!document.querySelector('svg.map'),"
                " body: document.body?.innerText?.slice(0, 200)})")
            parts.append(f"titre={raw.get('title')!r}, loader={raw.get('loader')!r}, message={raw.get('text')!r}, carte={'oui' if raw.get('svg') else 'non'}")
        except Exception as exc:  # noqa: BLE001
            parts.append(f"page illisible ({exc})")
        if self.failed_requests:
            parts.append("requêtes en échec : " + "; ".join(self.failed_requests[-3:]))
        if self.console_errors:
            parts.append("erreurs JS : " + "; ".join(self.console_errors[-3:]))
        if self.vision and self.vision.available:
            try:
                parts.append("vision : " + (await self.vision.describe(await self.stage.browser.screenshot_png())).get("summary", ""))
            except Exception:  # noqa: BLE001
                pass
        return " | ".join(parts)

    # ============================================================ géographie

    async def go_world(self) -> ActionReport:
        snap = await self.state()
        if snap.mode == "world" and not snap.raw.get("ficheOpen"):
            return ActionReport("go_world", True, "déjà au monde")
        crumb = self.page.locator(".trail .crumb").first
        await self.map.site_transition(lambda: crumb.click())
        snap = await self.state()
        ok = snap.mode == "world"
        self._forget_below("world")
        self.memory.record("go_world")
        return ActionReport("go_world", ok, "vue mondiale" if ok else f"mode={snap.mode}")

    def continent_id(self, text: str) -> str | None:
        wanted = fold(text)
        for cid, names in SANCTIMAPS_ADAPTER["continents"].items():
            if wanted == cid or any(fold(n) == wanted for n in names):
                return cid
        return None

    async def go_continent(self, cid: str) -> ActionReport:
        cont = self.site.continent_by_id.get(cid)
        if not cont:
            return ActionReport("go_continent", False, f"continent inconnu du site : {cid}")
        snap = await self.state()
        if snap.mode == "continent" and self.memory.selected_continent == cid:
            return ActionReport("go_continent", True, "déjà sur ce continent")
        if snap.mode in ("continent", "country"):
            current = self._continent_of_trail(snap)
            if current == cid:
                crumb = self.page.locator(".trail .crumb").nth(1)
                await self.map.site_transition(lambda: crumb.click())
                return await self._verify_continent(cid)
            await self.go_world()
        # Au monde : un clic sur un pays du continent ouvre le continent.
        members = sorted((self.site.country_by_id[c] for c in cont["countries"] if c in self.site.country_by_id),
                         key=lambda c: -c.get("area", 0))
        for country in members[:6]:
            point = await self.page.evaluate(COUNTRY_POINT_JS, country["id"])
            if point:
                await self.map.site_transition(lambda: self.page.mouse.click(point["x"], point["y"]))
                return await self._verify_continent(cid)
        return ActionReport("go_continent", False, "aucun pays cliquable pour ce continent")

    def _continent_of_trail(self, snap: Snapshot) -> str | None:
        if len(snap.trail) > 1:
            return self.continent_id(snap.trail[1])
        return None

    async def _verify_continent(self, cid: str) -> ActionReport:
        snap = await self.state()
        ok = snap.mode == "continent" and self._continent_of_trail(snap) == cid
        if ok:
            self.memory.selected_continent = cid
            self._forget_below("continent")
        self.memory.record(f"go_continent:{cid}")
        return ActionReport("go_continent", ok, " › ".join(snap.trail))

    async def go_to_country(self, name: str) -> ActionReport:
        iso = self.site.find_country(name)
        if not iso:
            return ActionReport("go_to_country", False, f"« {name} » n'est pas un pays connu de SanctiMaps")
        country = self.site.country_by_id[iso]
        label = self.site.country_name(iso)
        snap = await self.state()
        if snap.mode == "country" and snap.country == label:
            self._set_country(iso)
            return ActionReport("go_to_country", True, f"déjà sur {label}")
        if snap.raw.get("ficheOpen"):
            await self.close_profile()
        if snap.mode == "world" or self._continent_of_trail(snap) != country["continent"] or snap.mode == "country":
            if snap.mode != "continent" or self._continent_of_trail(snap) != country["continent"]:
                rep = await self.go_continent(country["continent"])
                if not rep.ok:
                    return ActionReport("go_to_country", False, f"continent non atteint : {rep.detail}")
        point = await self.page.evaluate(COUNTRY_POINT_JS, iso)
        # Un petit pays (Vatican, Malte…) peut être trop petit pour être touché :
        # on s'en approche d'abord, comme le ferait un lecteur.
        tries = 0
        while not point and tries < 4:
            lx, ly = country.get("label") or [(country["bbox"][0] + country["bbox"][2]) / 2,
                                               (country["bbox"][1] + country["bbox"][3]) / 2]
            anchor = await self.map.to_page(lx, ly)
            await self.map.pan_to_projected(lx, ly)
            await self.map.wheel_zoom(2.5, anchor=await self.map.to_page(lx, ly))
            point = await self.page.evaluate(COUNTRY_POINT_JS, iso)
            tries += 1
        if not point:
            return await self._vision_fallback("go_to_country", f"le pays {label} sur la carte")
        await self.map.site_transition(lambda: self.page.mouse.click(point["x"], point["y"]))
        snap = await self.state()
        ok = snap.mode == "country" and snap.country == label
        if ok:
            self._set_country(iso)
        self.memory.record(f"go_to_country:{iso}")
        return ActionReport("go_to_country", ok, f"{' › '.join(snap.trail)} — {snap.hint or ''}".strip(" —"),
                            {"iso": iso, "hint": snap.hint})

    def _set_country(self, iso: str) -> None:
        self.memory.selected_country = iso
        self.memory.selected_country_name = self.site.country_name(iso)
        self.memory.selected_continent = self.site.country_by_id[iso]["continent"]

    def _forget_below(self, level: str) -> None:
        if level in ("world", "continent"):
            self.memory.selected_country = None
            self.memory.selected_country_name = None
            self.memory.selected_place = None
        if level == "world":
            self.memory.selected_continent = None

    async def locate_place(self, name: str, country_hint: str | None = None) -> dict | None:
        """Où SanctiMaps situe ``name`` : ville publiée, ou région approximative."""
        iso = self.site.find_country(country_hint) if country_hint else None
        iso = iso or self.memory.selected_country
        city = await self.site.find_place(name, iso) if iso else None
        saints = []
        if not city:
            found = await self.corpus.city_country(name)
            if found:
                iso, saints = found
                city = await self.site.find_place(name, iso)
        if city:
            return {"name": city["n"], "iso": iso, "x": city["x"], "y": city["y"],
                    "kind": "ville", "approximate": False, "population": city.get("p")}
        if saints:
            # Le site ne connaît pas ce nom comme ville : c'est une région ou
            # une contrée. On ne prétend pas à plus de précision que lui.
            xs = [s["x"] for s in saints]
            ys = [s["y"] for s in saints]
            return {"name": saints[0]["city"], "iso": iso, "x": sum(xs) / len(xs), "y": sum(ys) / len(ys),
                    "kind": "région ou lieu approximatif", "approximate": True}
        return None

    async def go_to_place(self, name: str, country: str | None = None, ratio: float | None = None) -> ActionReport:
        place = await self.locate_place(name, country)
        if not place:
            return ActionReport("go_to_place", False, f"« {name} » : lieu introuvable dans les données de SanctiMaps")
        rep = await self.go_to_country(place["iso"])
        if not rep.ok:
            return ActionReport("go_to_place", False, f"pays non atteint : {rep.detail}")
        ratio = ratio or (3.0 if place["approximate"] else 6.0)
        move = await self.map.zoom_to_projected(place["x"], place["y"], ratio)
        # Vérification : le lieu est-il bien au centre de la carte ?
        px, py = await self.map.to_page(place["x"], place["y"])
        cx, cy = await self.map.center()
        g = await self.map.geometry()
        centered = abs(px - cx) < g["width"] * 0.2 and abs(py - cy) < g["height"] * 0.2
        label_visible = await self.page.evaluate(
            "(n) => [...document.querySelectorAll('.overlay .marker__label, .overlay .label__text')]"
            ".some(t => t.textContent.trim() === n && !t.closest('.is-crowded'))", place["name"])
        self.memory.selected_place = place["name"]
        self.memory.record(f"go_to_place:{place['name']}")
        detail = f"{place['name']} ({place['kind']}), zoom ×{move.achieved:.1f}"
        if place["approximate"]:
            detail += " — le site ne situe ce lieu qu'approximativement"
        return ActionReport("go_to_place", centered, detail,
                            {**place, "centered": centered, "label_visible": label_visible})

    # ================================================================ panneau

    async def open_sidebar_tab(self, tab: str) -> None:
        state = await self.page.evaluate(
            "(tab) => { const p = document.querySelector('#panel'); return {open: p.classList.contains('is-open'),"
            " menu: p.classList.contains('is-menu'), here: !!p.querySelector(tab === 'search' ? '.search' : '.' + tab)}; }", tab)
        if state["open"] and state["here"] and not state["menu"]:
            return
        if not state["open"]:
            await self.page.locator(".panel-toggle").click()
            await self.page.wait_for_selector("#panel.is-open")
        if not state["menu"] and not state["here"]:
            back = self.page.locator(".panel__back")
            if await back.count():
                await back.click()
        await self.page.locator(f'.menu__item[data-tab="{tab}"]').click()
        await self.page.wait_for_selector(f"#panel .{ 'search' if tab == 'search' else tab }")
        await self._settle_layout()
        await self.stage.hold(0.3)

    async def type_text(self, selector: str, text: str) -> None:
        """Saisie visible, lettre à lettre, au rythme du style."""
        field_ = self.page.locator(selector)
        await field_.click()
        await field_.fill("")
        per_char = 1.0 / max(1.0, self.style.typing_chars_per_s)
        frames_per_char = max(1, round(per_char * self.stage.fps))
        for ch in text:
            await self.page.keyboard.type(ch)
            for _ in range(frames_per_char):
                await self.stage.frame("action")

    # =============================================================== recherche

    async def search(self, query: str, scope: str | None = None) -> list[dict]:
        await self.open_sidebar_tab("search")
        if scope:
            label = SANCTIMAPS_ADAPTER["corpus"].get(scope, scope)
            chip = self.page.locator(".search .chip--scope", has_text=re.compile(f"^{label}$", re.I))
            if await chip.count() and (await chip.first.get_attribute("aria-pressed")) != "true":
                await chip.first.click()
        previous = await self.page.evaluate(
            "() => (document.querySelector('.search .results__summary') || {}).textContent || ''")
        await self.type_text(".search__input", query)
        try:
            await self.sync.wait_until_search_results(previous if previous and query else None, timeout_s=5)
        except SyncTimeout:
            pass  # même résumé qu'avant : les résultats sont déjà là
        return await self.read_results()

    async def read_results(self, limit: int = 60) -> list[dict]:
        return await self.page.evaluate(
            """(limit) => [...document.querySelectorAll('.search .results .result, .daily .results .result')].slice(0, limit).map((r, i) => ({
                index: i,
                name: (r.querySelector('.result__name') || {}).textContent?.trim() || '',
                meta: (r.querySelector('.result__meta') || {}).textContent?.trim() || '',
                dates: (r.querySelector('.result__dates') || {}).textContent?.trim() || '',
            }))""", limit)

    @staticmethod
    def score_result(query: str, result: dict) -> float:
        """Préférer le nom exact, puis le nom qui commence par la requête."""
        stop = {"saint", "sainte", "saints", "st", "ste", "bienheureux", "bienheureuse", "venerable", "le", "la"}
        q = [w for w in fold(query).split() if w not in stop]
        name = fold(result["name"])
        words = [w for w in name.split() if w not in stop]
        if not q:
            return 0.0
        score = 0.0
        if words == q:
            score += 100
        if words[: len(q)] == q:
            score += 40
        score += 10 * sum(1 for w in q if w in words)
        score -= 0.5 * max(0, len(words) - len(q))
        if fold(query) in name:
            score += 5
        return score

    async def best_result(self, query: str, results: list[dict]) -> dict:
        """Le résultat le plus proche de la requête ; à égalité, la fiche la mieux
        fournie du site (« saint Louis » : le roi plutôt qu'un homonyme obscur)."""
        scored = [(self.score_result(query, r), r) for r in results]
        top = max(s for s, _ in scored)
        # Un mot de plus (« de Lisieux ») ne doit pas suffire à écarter le saint le plus connu.
        tied = [r for s, r in scored if s >= top - 2]
        if len(tied) == 1:
            return tied[0]
        fame = await self.corpus.fame_by_name()
        return max(tied, key=lambda r: fame.get(fold(r["name"]), 0.0))

    async def search_saint(self, query: str, pick: int | None = None, close_panel: bool = True) -> ActionReport:
        """Trouve un saint par la recherche du site et ouvre sa fiche, vérifiée."""
        cleaned = re.sub(r"^(saint|sainte|st|ste|bienheureux|bienheureuse|vénérable)\s+", "", query.strip(), flags=re.I)
        results = await self.search(cleaned, scope="saints")
        if not results:
            return ActionReport("search_saint", False, f"aucun résultat pour « {query} »")
        if pick is None:
            chosen = await self.best_result(query, results)
        else:
            chosen = results[min(pick, len(results) - 1)]
        rep = await self._open_result(chosen)
        if rep.ok and close_panel:
            await self.close_sidebar()
            await self.map.stabilize()
        rep.action = "search_saint"
        rep.data["candidates"] = results[:8]
        return rep

    async def _open_result(self, chosen: dict) -> ActionReport:
        item = self.page.locator(".results .result").nth(chosen["index"])
        await item.scroll_into_view_if_needed()
        await self.stage.hold(0.3)
        # Ouvrir un saint fait voler la carte jusqu'à son pays : transition du site.
        await self.map.site_transition(lambda: item.click())
        try:
            await self.sync.wait_until_panel_open()
        except SyncTimeout:
            return ActionReport("open_result", False, "la fiche ne s'est pas ouverte")
        snap = await self.state()
        ok = fold(snap.fiche_name or "") == fold(chosen["name"])
        if ok:
            self.memory.selected_saint = snap.fiche_name
            if snap.mode == "country" and snap.country:
                iso = self.site.find_country(snap.country)
                if iso:
                    self._set_country(iso)
        self.memory.record(f"open_saint:{chosen['name']}")
        return ActionReport("open_result", ok,
                            f"fiche « {snap.fiche_name} »" + ("" if ok else f" au lieu de « {chosen['name']} »"),
                            {"chosen": chosen})

    # ================================================================== fiche

    async def read_profile(self) -> dict | None:
        raw = await self.page.evaluate(PROFILE_JS)
        if not raw:
            return None
        rows = {}
        for key, value in raw["rows"]:
            norm = SANCTIMAPS_ADAPTER["profile_rows"].get(fold(key), fold(key))
            rows[norm] = value
        approx = [k for k in ("born", "died", "year") if rows.get(k, "").lower().startswith("vers")]
        return {**raw, "fields": rows, "approximate_dates": approx}

    async def open_profile(self, name: str | None = None) -> ActionReport:
        snap = await self.state()
        if snap.has(SiteState.SAINT_PROFILE_OPEN) and (not name or fold(name) in fold(snap.fiche_name or "")):
            return ActionReport("open_profile", True, f"fiche « {snap.fiche_name} » déjà ouverte")
        target = name or self.memory.selected_saint
        if not target:
            return ActionReport("open_profile", False, "aucun saint sélectionné")
        return await self.search_saint(target)

    async def show_profile(self, seconds: float | None = None) -> ActionReport:
        """Laisse lire la fiche : pause puis défilement doux de la biographie."""
        await self.sync.wait_until_panel_open()
        profile = await self.read_profile()
        if not profile:
            return ActionReport("show_profile", False, "pas de fiche ouverte")
        text_len = len(profile.get("biography") or "") + len(profile.get("description") or "")
        reading = max(self.style.hold_s, min(12.0, text_len / 100 * self.style.reading_s_per_100_chars))
        seconds = seconds or reading
        overflow = max(0, profile["scrollHeight"] - profile["clientHeight"])
        first = seconds * 0.35
        await self.stage.hold(first)
        if overflow > 20:
            frames = self.stage.seconds_to_frames(seconds * 0.5)
            distance = min(overflow, profile["clientHeight"] * 1.2)
            for i in range(1, frames + 1):
                y = distance * (0.5 - 0.5 * math.cos(math.pi * i / frames))
                await self.page.evaluate("(y) => { const b = document.querySelector('.fiche__body'); if (b) b.scrollTop = y; }", y)
                await self.stage.frame("action")
            await self.stage.hold(seconds * 0.15)
        else:
            await self.stage.hold(seconds * 0.65)
        return ActionReport("show_profile", True, profile.get("title") or "", {"profile": profile})

    async def close_profile(self) -> ActionReport:
        snap = await self.state()
        if not snap.raw.get("ficheOpen"):
            return ActionReport("close_profile", True, "aucune fiche ouverte")
        await self.page.locator(".fiche__close").click()
        await self.sync.wait_until_panel_closed()
        await self.map.stabilize()
        self.memory.record("close_profile")
        return ActionReport("close_profile", True)

    async def open_cluster_near_center(self, prefer_single: bool = True) -> ActionReport:
        """Touche le repère de saints le plus proche du centre (liste ou fiche)."""
        pts = await self.page.evaluate(
            """() => { const h = document.querySelector('#map-host').getBoundingClientRect();
              const cx = h.left + h.width / 2, cy = h.top + h.height / 2;
              return [...document.querySelectorAll('.overlay [data-cluster]')].filter(m => !m.classList.contains('is-crowded'))
                .map(m => { const r = m.querySelector('.marker__badge, .marker__ring, circle').getBoundingClientRect();
                  const count = parseInt((m.querySelector('.marker__count') || {}).textContent || '1', 10) || 1;
                  return {x: r.left + r.width / 2, y: r.top + r.height / 2, count,
                          d: Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy)}; })
                .filter(p => p.x > h.left + 20 && p.x < h.right - 20 && p.y > h.top + 60 && p.y < h.bottom - 20)
                .sort((a, b) => a.d - b.d).slice(0, 12); }""")
        if not pts:
            return ActionReport("open_cluster", False, "aucun repère visible")
        if prefer_single:
            singles = [p for p in pts if p["count"] == 1]
            pts = singles or pts
        target = pts[0]
        await self.page.mouse.move(target["x"], target["y"], steps=8)
        await self.stage.hold(0.2)
        await self.page.mouse.click(target["x"], target["y"])
        for _ in range(10):
            await self.stage.frame("wait")
            snap = await self.state()
            if snap.raw.get("picker") or snap.raw.get("ficheOpen"):
                break
        snap = await self.state()
        if snap.raw.get("picker"):
            await self.stage.hold(0.8)
            item = self.page.locator(".picker.is-open .picker__item").first
            name = (await item.locator(".picker__name").text_content() or "").strip()
            await item.click()
        else:
            name = None
        try:
            await self.sync.wait_until_panel_open()
        except SyncTimeout:
            return ActionReport("open_cluster", False, "le repère n'a pas ouvert de fiche")
        snap = await self.state()
        await self.map.stabilize()
        ok = snap.has(SiteState.SAINT_PROFILE_OPEN) and (not name or fold(name) == fold(snap.fiche_name or ""))
        self.memory.selected_saint = snap.fiche_name
        return ActionReport("open_cluster", ok, f"fiche « {snap.fiche_name} »")

    # ================================================================ siècles

    async def filter_by_century(self, century: int, country: str | None = None) -> ActionReport:
        """« Les saints du XIIe siècle » : filtre de siècle de la recherche du site."""
        query = f"{roman(century)}e siècle"
        if country:
            iso = self.site.find_country(country)
            if iso:
                query = f"{self.site.country_name(iso)} {query}"
        results = await self.search(query, scope="saints")
        tokens = await self.page.evaluate(
            "() => [...document.querySelectorAll('.search .chip--token')].map(c => ({cls: c.className, text: c.textContent.replace('×','').trim()}))")
        century_ok = any("chip--century" in t["cls"] and re.search(rf"(?<!\d){century}(?!\d)", t["text"]) for t in tokens)
        summary = await self.page.evaluate("() => (document.querySelector('.search .results__summary') || {}).textContent || ''")
        if century_ok:
            self.memory.current_century = century
        self.memory.record(f"filter_by_century:{century}")
        return ActionReport("filter_by_century", century_ok, f"{summary} — filtres : {', '.join(t['text'] for t in tokens)}",
                            {"results": results[:20], "summary": summary})

    # ============================================================== calendrier

    async def open_calendar(self) -> ActionReport:
        await self.open_sidebar_tab("daily")
        date_text = await self.page.locator(".daily__date").text_content()
        count = await self.page.evaluate("() => (document.querySelector('.daily .results__summary, .daily .results__empty') || {}).textContent || ''")
        self.memory.record("open_calendar")
        return ActionReport("open_calendar", True, f"{date_text} — {count}", {"date": date_text,
                            "results": await self.read_results()})

    @staticmethod
    def parse_day(text: str, today: dt.date) -> dt.date | None:
        t = fold(text)
        if t in ("aujourd hui", "today", "ce jour"):
            return today
        if t == "demain":
            return today + dt.timedelta(days=1)
        if t == "hier":
            return today - dt.timedelta(days=1)
        m = re.search(r"(\d{1,2})(?:er)?\s+([a-z]+)", t)
        if m:
            months = [fold(x) for x in MONTHS_FR]
            for i, name in enumerate(months):
                if name.startswith(m.group(2)[:3]):
                    try:
                        return dt.date(today.year, i + 1, int(m.group(1)))
                    except ValueError:
                        return None
        m = re.search(r"(\d{1,2})[/-](\d{1,2})", t)
        if m:
            try:
                return dt.date(today.year, int(m.group(2)), int(m.group(1)))
            except ValueError:
                return None
        return None

    async def select_feast_day(self, day: str) -> ActionReport:
        """Montre les saints fêtés un jour donné, avec le calendrier du site."""
        today = dt.date.fromisoformat(await self.page.evaluate(
            "() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }"))
        target = self.parse_day(day, today)
        if not target:
            return ActionReport("select_feast_day", False, f"date non comprise : « {day} »")
        offset = (target - today).days
        if abs(offset) <= 7:
            await self.open_calendar()
            if offset:
                btn = self.page.locator(".daily__nav button").nth(1 if offset > 0 else 0)
                for _ in range(abs(offset)):
                    await btn.click()
                    await self.stage.hold(0.5)
            date_text = (await self.page.locator(".daily__date").text_content()) or ""
            ok = str(target.day) in date_text and fold(MONTHS_FR[target.month - 1]) in fold(date_text)
            results = await self.read_results()
            self.memory.record(f"select_feast_day:{target.isoformat()}")
            return ActionReport("select_feast_day", ok, f"{date_text} — {len(results)} fiche(s)", {"results": results})
        # Plus loin : le filtre de date de la recherche du site (« 4 septembre »).
        label = f"{target.day} {MONTHS_FR[target.month - 1]}"
        results = await self.search(label, scope="saints")
        tokens = await self.page.evaluate("() => [...document.querySelectorAll('.search .chip--feast')].map(c => c.textContent)")
        ok = bool(tokens)
        self.memory.record(f"select_feast_day:{target.isoformat()}")
        return ActionReport("select_feast_day", ok, f"{label} — {len(results)} fiche(s)", {"results": results})

    # ============================================================ apparitions

    async def set_corpus(self, corpus: str) -> ActionReport:
        label = SANCTIMAPS_ADAPTER["corpus"][corpus]
        btn = self.page.locator(".corpus__btn", has_text=re.compile(f"^{label}$", re.I))
        if await btn.count() == 0:
            btn = self.page.locator(".corpus__btn").nth(list(SANCTIMAPS_ADAPTER["corpus"]).index(corpus))
        if (await btn.first.get_attribute("aria-pressed")) != "true":
            await btn.first.click()
            await self.stage.hold(0.4)
        await self.map.stabilize()
        snap = await self.state()
        ok = snap.corpus == corpus
        self.memory.current_mode = snap.corpus or corpus
        self.memory.record(f"corpus:{corpus}")
        legend = await self.page.evaluate("() => (document.querySelector('.legend') || {}).textContent || ''")
        return ActionReport(f"corpus:{corpus}", ok, legend.strip()[:120])

    # ------------------------------------------------------ autres actions

    async def level_up(self) -> ActionReport:
        """Remonte d'un niveau par le fil d'Ariane : pays → continent → monde."""
        snap = await self.state()
        if snap.raw.get("ficheOpen"):
            await self.close_profile()
            snap = await self.state()
        if snap.mode == "world":
            return ActionReport("level_up", True, "déjà au monde")
        crumb = self.page.locator(".trail .crumb").nth(1 if snap.mode == "country" else 0)
        await self.map.site_transition(lambda: crumb.click())
        snap = await self.state()
        self._forget_below("continent" if snap.mode == "continent" else "world")
        return ActionReport("level_up", True, " › ".join(snap.trail))

    async def fiche_button(self, kind: str) -> ActionReport:
        """« Voir les lieux qu'il a marqués » / « les saints qu'il a pu croiser »."""
        await self.sync.wait_until_panel_open()
        sel = ".detail__lieux-btn" if kind == "lieux" else ".detail__croises-btn"
        btn = self.page.locator(sel)
        if not await btn.count():
            return ActionReport(f"show_{kind}", False, "la fiche n'en indique pas")
        if "is-on" not in (await btn.get_attribute("class") or ""):
            await self.map.site_transition(lambda: btn.click())
        on = await self.page.locator(f"{sel}.is-on").count() > 0
        return ActionReport(f"show_{kind}", on, (await btn.text_content() or "").strip())

    async def search_list(self, query: str) -> ActionReport:
        results = await self.search(query, scope="saints")
        summary = await self.page.evaluate("() => (document.querySelector('.search .results__summary') || {}).textContent || ''")
        return ActionReport("search_list", bool(results), f"« {query} » : {summary}", {"results": results[:20]})

    async def frame_view(self, x: float, y: float, ratio: float, country: str | None) -> ActionReport:
        """Retrouve un cadrage montré à la main dans le studio."""
        if (await self.state()).raw.get("ficheOpen"):
            await self.close_profile()
        if country and (self.memory.selected_country != country or (await self.state()).mode != "country"):
            rep = await self.go_to_country(country)
            if not rep.ok:
                return rep
        move = await self.map.zoom_to_projected(x, y, ratio or 1.0)
        return ActionReport("frame_view", True, f"×{ratio or 1:.1f} {move.note}".strip())

    # ------------------------------------------------- secours par la vision

    async def _vision_fallback(self, action: str, target: str) -> ActionReport:
        if not (self.vision and self.vision.available):
            return ActionReport(action, False, f"{target} introuvable par le DOM (vision indisponible)")
        shot = await self.stage.browser.screenshot_png()
        found = await self.vision.locate(shot, target)
        if not found or not found.get("found"):
            return ActionReport(action, False, f"{target} introuvable, y compris par la vision")
        await self.page.mouse.click(found["x"], found["y"])
        await self.map.stabilize()
        return ActionReport(action, True, f"{target} localisé par la vision", found)
