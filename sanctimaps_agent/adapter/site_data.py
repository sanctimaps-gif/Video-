"""Données publiées par le site, lues à chaque session.

Le site sert ses propres fichiers de données (``data/generated/…``). L'agent les
lit par la page, sur la même origine — c'est le contenu que la carte affiche,
pas une copie gardée par l'agent. Seul le nécessaire est chargé : la géographie
(pays, continents, cadres), et les villes d'un pays à la demande.
"""

from __future__ import annotations

import logging
import unicodedata

log = logging.getLogger(__name__)


def fold(text: str) -> str:
    """Minuscules, sans accents ni ponctuation superflue : « Saint-Étienne » → « saint etienne »."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    for ch in "'’`-_.,;:()\"«»":
        text = text.replace(ch, " ")
    return " ".join(text.split())


class SiteData:
    def __init__(self, page, base: str = "data/generated"):
        self.page = page
        self.base = base
        self.world: dict | None = None
        self.names: dict[str, dict] = {}
        self.country_by_id: dict[str, dict] = {}
        self.continent_by_id: dict[str, dict] = {}
        self._cities: dict[str, list[dict]] = {}
        self._country_index: list[tuple[str, str]] = []

    async def _get(self, path: str):
        return await self.page.evaluate(
            "async (p) => { const r = await fetch(p); if (!r.ok) throw new Error(r.status + ' ' + p); return r.json(); }",
            f"{self.base}/{path}",
        )

    async def load(self) -> None:
        self.world = await self._get("world.json")
        self.names = await self._get("country-names.json")
        self.country_by_id = {c["id"]: c for c in self.world["countries"]}
        self.continent_by_id = {c["id"]: c for c in self.world["continents"]}
        index = []
        for iso, country in self.country_by_id.items():
            labels = {country.get("name", "")}
            labels.update(v for v in self.names.get(iso, {}).values() if isinstance(v, str))
            for label in labels:
                if label:
                    index.append((fold(label), iso))
        # Les noms longs d'abord : « Guinée équatoriale » avant « Guinée ».
        self._country_index = sorted(index, key=lambda item: -len(item[0]))

    def country_name(self, iso: str, lang: str = "fr") -> str:
        return self.names.get(iso, {}).get(lang) or self.country_by_id.get(iso, {}).get("name", iso)

    def find_country(self, text: str) -> str | None:
        """Le code ISO du pays nommé dans ``text`` (nom exact prioritaire)."""
        wanted = fold(text)
        if not wanted:
            return None
        up = text.strip().upper()
        if up in self.country_by_id:
            return up
        for label, iso in self._country_index:
            if label == wanted:
                return iso
        padded = f" {wanted} "
        for label, iso in self._country_index:
            if len(label) >= 4 and f" {label} " in padded:
                return iso
        return None

    def countries_in_text(self, text: str) -> list[str]:
        padded = f" {fold(text)} "
        found: list[str] = []
        for label, iso in self._country_index:
            if len(label) >= 4 and f" {label} " in padded and iso not in found:
                found.append(iso)
                padded = padded.replace(f" {label} ", " ")
        return found

    async def cities(self, iso: str) -> list[dict]:
        if iso not in self._cities:
            try:
                self._cities[iso] = await self._get(f"cities/{iso}.json")
            except Exception:  # noqa: BLE001 - un pays sans villes publiées
                self._cities[iso] = []
        return self._cities[iso]

    async def find_place(self, name: str, iso: str | None = None) -> dict | None:
        """Une ville publiée par le site : {n, x, y, p, country}. ``None`` sinon."""
        wanted = fold(name)
        candidates = [iso] if iso else [c for c in self.country_by_id]
        best = None
        for code in candidates:
            if not iso and code not in self._cities:
                continue  # sans pays connu, on ne charge pas 234 fichiers
            for city in await self.cities(code):
                if fold(city.get("n", "")) == wanted:
                    if best is None or city.get("p", 0) > best.get("p", 0):
                        best = {**city, "country": code}
        return best


class CorpusData:
    """Fiches publiées (saints.json, apparitions.json, textes) — chargées à la demande.

    Sert à *choisir* (quel saint montrer, dans quel pays est une ville) et à
    *vérifier* ; ce qui est filmé passe toujours par l'interface du site.
    """

    def __init__(self, site: SiteData):
        self.site = site
        self._saints: list[dict] | None = None
        self._texts: dict | None = None
        self._apparitions: list[dict] | None = None

    async def saints(self) -> list[dict]:
        if self._saints is None:
            self._saints = (await self.site._get("saints.json"))["saints"]
        return self._saints

    async def apparitions(self) -> list[dict]:
        if self._apparitions is None:
            try:
                self._apparitions = (await self.site._get("apparitions.json"))["apparitions"]
            except Exception:  # noqa: BLE001
                self._apparitions = []
        return self._apparitions

    async def texts(self) -> dict:
        if self._texts is None:
            try:
                self._texts = await self.site._get("saints-texts.json")
            except Exception:  # noqa: BLE001
                self._texts = {}
        return self._texts

    async def city_country(self, name: str) -> tuple[str, list[dict]] | None:
        """Le pays où le site place le plus de saints nés à ``name``, et ces saints."""
        wanted = fold(name)
        by_country: dict[str, list[dict]] = {}
        for saint in await self.saints():
            if fold(saint.get("city", "")) == wanted:
                by_country.setdefault(saint["country"], []).append(saint)
        if not by_country:
            return None
        iso = max(by_country, key=lambda c: len(by_country[c]))
        return iso, by_country[iso]

    async def fame_by_name(self) -> dict[str, float]:
        """Richesse de chaque fiche, par nom français replié."""
        if getattr(self, "_fame", None) is None:
            texts = await self.texts()
            fame: dict[str, float] = {}
            for saint in await self.saints():
                name = saint.get("name", {})
                label = fold(name.get("fr") if isinstance(name, dict) else str(name))
                fame[label] = max(fame.get(label, 0.0), _richness(saint, texts))
            self._fame = fame
        return self._fame

    async def interesting(self, iso: str | None = None, limit: int = 5, century: int | None = None) -> list[dict]:
        """Des fiches bien fournies : biographie longue, patronage, qualités, statut de saint."""
        texts = await self.texts()
        scored = []
        for saint in await self.saints():
            if iso and saint.get("country") != iso:
                continue
            if century and _century(saint) != century:
                continue
            scored.append((_richness(saint, texts), saint))
        scored.sort(key=lambda item: -item[0])
        return [s for _, s in scored[:limit]]


def _richness(saint: dict, texts: dict) -> float:
    bio = ((texts.get(saint["id"], {}) or {}).get("bio") or {}).get("fr") or ""
    score = min(len(bio), 3000) / 100
    # Le patronage n'est renseigné que pour les saints les plus connus (≈ 5 % des fiches).
    score += 8 if saint.get("patronage") else 0
    score += len(saint.get("titles") or [])
    score += 4 if saint.get("statut") == "saint" else 0
    score -= 3 if saint.get("circa") else 0
    return score


def _century(saint: dict) -> int | None:
    year = saint.get("born") if saint.get("born") is not None else saint.get("died")
    if year is None:
        return None
    return (year - 1) // 100 + 1 if year > 0 else -((-year - 1) // 100 + 1)
