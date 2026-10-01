"""ScenarioPlanner : d'une demande en français à un scénario minuté.

Le planificateur à règles couvre les demandes courantes sans aucun service
externe. Si une clé Anthropic est disponible, Claude peut proposer le
découpage ; sa proposition est validée (vocabulaire d'actions fermé, lieux
vérifiés dans les données du site) et le planificateur à règles reprend la
main en cas de doute.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass

from .adapter.site_data import CorpusData, SiteData, fold
from .config import STYLES, MotionStyle
from .scenario import ACTIONS, Scenario, Shot

log = logging.getLogger(__name__)

ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10,
         "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15, "xvi": 16, "xvii": 17, "xviii": 18,
         "xix": 19, "xx": 20, "xxi": 21}

CONTINENT_WORDS = {
    "europe": "europe", "afrique": "africa", "asie": "asia", "oceanie": "oceania",
    "amerique du nord": "north-america", "amerique du sud": "south-america",
    "amerique latine": "south-america",
}

NUMBER_WORDS = {"une": 1, "un": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6,
                "dix": 10, "quinze": 15, "vingt": 20, "trente": 30, "quarante": 40,
                "quarante cinq": 45, "soixante": 60, "quatre vingt dix": 90}


@dataclass
class Intent:
    action: str
    params: dict
    weight: float = 1.0  # part de temps libre attribuée au plan


def parse_duration(text: str) -> float | None:
    t = fold(text)
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:min|minutes?)\b(?:\s*(\d+))?", t)
    if m:
        return float(m.group(1).replace(",", ".")) * 60 + (float(m.group(2)) if m.group(2) else 0)
    m = re.search(r"(\d+)\s*(?:s|sec|secs|secondes?)\b", t)
    if m:
        return float(m.group(1))
    for word, n in sorted(NUMBER_WORDS.items(), key=lambda kv: -len(kv[0])):
        if re.search(rf"\b{word} minutes?\b", t):
            return n * 60.0
        if re.search(rf"\b{word} secondes?\b", t):
            return float(n)
    return None


def parse_aspect(text: str) -> str | None:
    t = fold(text)
    if re.search(r"\b(verticale?|portrait|9 16|9:16|tiktok|reels?|shorts?|story|stories)\b", t) or "9:16" in text:
        return "9:16"
    if re.search(r"\b(carree?|1 1|instagram)\b", t) or "1:1" in text:
        return "1:1"
    if re.search(r"\b(horizontale?|paysage|16 9|youtube)\b", t) or "16:9" in text:
        return "16:9"
    return None


def parse_resolution(text: str) -> str | None:
    t = fold(text)
    if re.search(r"\b(4k|2160p?|uhd)\b", t):
        return "4k"
    if re.search(r"\b720p?\b", t):
        return "720p"
    return None


def parse_style(text: str) -> str | None:
    t = fold(text)
    for pattern, style in ((r"cinemat|cinema|epique", "cinematic"), (r"documentaire", "documentary"),
                           (r"pedagog|educati|didacti|lisib", "educational"),
                           (r"\brapide|dynamique|nerveu", "fast"), (r"\blente?\b|lentement|posee?", "slow")):
        if re.search(pattern, t):
            return style
    return None


def parse_century(text: str) -> int | None:
    t = fold(text)
    m = re.search(r"\b([ivx]+)(?:e|eme|er)?\s+siecles?\b", t)
    if m and m.group(1) in ROMAN:
        return ROMAN[m.group(1)]
    m = re.search(r"\b(\d{1,2})\s*(?:e|eme|er)?\s+siecles?\b", t)
    if m and 1 <= int(m.group(1)) <= 21:
        return int(m.group(1))
    return None


def split_clauses(text: str) -> list[str]:
    parts = re.split(r"[.;,]|\bpuis\b|\bensuite\b|\bet enfin\b|\benfin\b|\bet (?=(?:revien|retour|termin|fini|montre|affich|ouvr|zoom|descend|rapproche|passe))",
                     text, flags=re.I)
    return [p.strip() for p in parts if p and p.strip()]


class ScenarioPlanner:
    def __init__(self, site: SiteData, corpus: CorpusData, memory=None, use_llm: bool = True,
                 model: str = "claude-opus-5-5"):
        self.site = site
        self.corpus = corpus
        self.memory = memory
        self.model = model
        self.use_llm = use_llm and bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))

    # ----------------------------------------------------------- entités

    async def find_places(self, clause: str, country_iso: str | None) -> list[str]:
        """Noms propres de la phrase que le site connaît comme lieux (ville ou région)."""
        found = []
        candidates = re.findall(r"\b([A-ZÉÈÂÎ][\w'’-]+(?:[ -](?:de|du|la|le|sur|en|d’|d')?[ -]?[A-ZÉÈ][\w'’-]+)*)", clause)
        skip = {"fais", "fait", "crée", "cree", "commence", "montre", "va", "zoome", "cherche", "ouvre",
                "termine", "passe", "reviens", "sanctimaps", "saint", "sainte", "puis", "la", "le", "les"}
        for cand in candidates:
            f = fold(cand)
            if f in skip or self.site.find_country(cand) or f in CONTINENT_WORDS:
                continue
            if country_iso and await self.site.find_place(cand, country_iso):
                found.append(cand)
                continue
            if await self.corpus.city_country(cand):
                found.append(cand)
        return found

    @staticmethod
    def saint_names(clause: str) -> list[str]:
        names = re.findall(r"\b(?:saint|sainte|bienheureux|bienheureuse)\s+([A-ZÉÈ][\w'’-]+(?:\s+(?:de|d’|d'|du|la|le)?\s*[A-ZÉÈ][\w'’-]+)*)", clause)
        names += re.findall(r"\bfiche (?:de|du|d’|d')\s*([A-ZÉÈ][\w'’-]+(?:\s+[A-ZÉÈ][\w'’-]+)*)", clause)
        return names

    # ------------------------------------------------------------- règles

    async def intents_from_text(self, text: str) -> tuple[list[Intent], list[str]]:
        intents: list[Intent] = []
        notes: list[str] = []
        country_iso = self.memory.selected_country if self.memory else None
        last_place: str | None = None
        saw_saint = False
        apparitions = False

        clauses = split_clauses(text)
        header_end = None  # nombre d'intentions issues de la phrase d'annonce (« Crée une vidéo… »)
        for n_clause, clause in enumerate(clauses):
            if n_clause == 1 and re.search(r"\b(video|film|clip)\b", fold(clauses[0])):
                header_end = len(intents)
            c = fold(clause)
            if re.search(r"\b(vue (du|de la|mondiale)|du monde|planisphere|monde entier|le monde)\b", c) \
                    and not re.search(r"\b(revien|retour|termin)", c):
                intents.append(Intent("establish_world", {}, 0.8))
            for word, cid in CONTINENT_WORDS.items():
                if re.search(rf"\b{word}\b", c) and not self.site.countries_in_text(clause):
                    intents.append(Intent("open_continent", {"continent": cid}, 0.6))
            returning = re.search(r"\b(revien|retour|remonte|recule|termine (sur|par|avec) une vue|finit sur une vue)", c)
            countries = self.site.countries_in_text(clause)
            for iso in countries:
                if returning:
                    intents.append(Intent("close_profile", {}, 0.1))
                    if country_iso == iso or not country_iso:
                        intents.append(Intent("fit_country", {"country": iso}, 1.0))
                    else:
                        intents.append(Intent("open_country", {"country": iso}, 1.0))
                else:
                    intents.append(Intent("open_country", {"country": iso}, 1.2))
                country_iso = iso
            if returning and not countries and re.search(r"\bmonde\b", c):
                intents.append(Intent("back_to_world", {}, 0.8))
            century = parse_century(clause)
            if century:
                intents.append(Intent("century_filter", {"century": century, "country": country_iso}, 1.2))
            if re.search(r"\bcalendrier|fete(s)? (aujourd|le|du|ce)|saint du jour|fetes? aujourd", c):
                day = "aujourd'hui"
                m = re.search(r"\b(\d{1,2}(?:er)?\s+(?:janv|fevr|mars|avri|mai|juin|juil|aout|sept|octo|nove|dece)\w*)", c)
                if m:
                    day = m.group(1)
                intents.append(Intent("calendar", {"day": day}, 1.5))
            if re.search(r"\bapparitions?\b", c) or (apparitions and not returning):
                names = [p for p in await self.find_places(clause, None)]
                if not apparitions:
                    intents.append(Intent("apparitions_on", {}, 0.5))
                    apparitions = True
                if names:
                    intents.append(Intent("open_apparition", {"name": names[0]}, 0.6))
                    intents.append(Intent("show_profile", {}, 2.0))
                    saw_saint = True
            elif not returning:
                for place in await self.find_places(clause, country_iso):
                    intents.append(Intent("zoom_to_place", {"place": place, "country": country_iso}, 1.2))
                    last_place = place
            if re.search(r"\bplusieurs (zones|villes|regions|lieux|endroits)|differentes (zones|regions|villes)|parcour|survol", c):
                intents.append(Intent("zoom_to_place", {"place": "@tour:0", "country": country_iso}, 1.0))
                intents.append(Intent("pan_to_place", {"place": "@tour:1", "country": country_iso}, 1.0))
                intents.append(Intent("pan_to_place", {"place": "@tour:2", "country": country_iso}, 1.0))
            for name in self.saint_names(clause):
                intents.append(Intent("open_saint", {"query": name}, 0.8))
                intents.append(Intent("show_profile", {}, 2.0))
                saw_saint = True
            if re.search(r"\bfiche\b", c) and not self.saint_names(clause) and not saw_saint:
                # « la fiche du saint sélectionné », « une fiche intéressante »
                selected = self.memory.selected_saint if self.memory else None
                if re.search(r"selectionne|choisi|actuel|ce saint|sa fiche", c) and selected:
                    intents.append(Intent("open_saint", {"query": selected}, 0.8))
                else:
                    intents.append(Intent("open_saint", {"query": "@interesting", "country": country_iso,
                                                         "place": last_place}, 0.8))
                intents.append(Intent("show_profile", {}, 2.0))
                saw_saint = True
            if re.search(r"\bzoom(e)? arriere|dezoom|recule\b", c) and not returning:
                intents.append(Intent("zoom_out", {"factor": 2.0}, 0.8))
            elif re.search(r"\bzoom(e)? (avant|davantage|plus)|rapproche[- ]toi\b", c) and not countries:
                intents.append(Intent("zoom_in", {"factor": 2.0}, 0.8))
            if re.search(r"\bsaints? (de|du|en|d')\b", c) and countries and not saw_saint and "fiche" not in c:
                pass  # « les saints de France » : la vue du pays les montre (compte affiché).

        # La phrase d'annonce donne le sujet ; si la suite redit les mêmes
        # mouvements, ce sont eux qui comptent.
        if header_end:
            head, rest = intents[:header_end], intents[header_end:]
            if all(any(r.action == h.action and r.params == h.params for r in rest) for h in head):
                intents = rest
        intents = self._clean(intents)
        # Depuis le monde, descendre directement dans un pays saute une étape :
        # on passe par son continent, comme le fait le site.
        out: list[Intent] = []
        for it in intents:
            if it.action == "open_country" and (not out or out[-1].action == "establish_world"):
                cont = self.site.country_by_id.get(it.params["country"], {}).get("continent")
                if cont:
                    out.append(Intent("open_continent", {"continent": cont}, 0.6))
            out.append(it)
        intents = out
        # Un pays seul : on y montre une zone, puis on revient à la vue d'ensemble.
        if intents and intents[-1].action == "open_country" and all(
                i.action in ("establish_world", "open_continent", "open_country") for i in intents):
            iso = intents[-1].params["country"]
            intents += [Intent("zoom_to_place", {"place": "@tour:0", "country": iso}, 1.0),
                        Intent("fit_country", {"country": iso}, 0.8)]
        if not intents:
            notes.append("Demande non reconnue : scénario de découverte par défaut.")
        return intents, notes

    @staticmethod
    def _clean(intents: list[Intent]) -> list[Intent]:
        out: list[Intent] = []
        for it in intents:
            if out and out[-1].action == it.action and out[-1].params == it.params:
                continue
            out.append(it)
        return out

    # ----------------------------------------------------------- minutage

    @staticmethod
    def natural_seconds(action: str, style: MotionStyle, from_world: bool = False) -> float:
        t = style.transition_s
        return {
            "establish_world": style.hold_s,
            "open_continent": t + style.settle_s,
            "open_country": (2 * t if from_world else t) + style.settle_s,
            "zoom_to_place": 1.6 + 2.6 * style.zoom_s_per_doubling + style.settle_s,
            "pan_to_place": 2.0 + style.settle_s,
            "zoom_in": style.zoom_s_per_doubling + style.settle_s,
            "zoom_out": style.zoom_s_per_doubling + style.settle_s,
            "pan": 1.5 + style.settle_s,
            "fit_country": t + style.settle_s,
            "back_to_world": t + style.settle_s,
            "open_saint": 10 / style.typing_chars_per_s + t + 1.0,
            "open_marker": 1.5,
            "show_profile": style.hold_s * 1.5,
            "close_profile": 0.6,
            "century_filter": 14 / style.typing_chars_per_s + 1.5,
            "calendar": 1.5,
            "apparitions_on": 1.0,
            "apparitions_off": 1.0,
            "open_apparition": 8 / style.typing_chars_per_s + t + 1.0,
            "hold": style.hold_s,
            "level_up": t + style.settle_s,
            "miracles_on": 1.0,
            "show_lieux": t + style.settle_s + 1,
            "show_croises": t + style.settle_s + 1,
            "search_list": 12 / style.typing_chars_per_s + 1.5,
            "close_panel": 0.6,
            "frame_view": 1.6 + 2.6 * style.zoom_s_per_doubling + style.settle_s,
        }[action]

    def schedule(self, intents: list[Intent], style_name: str, target_s: float | None) -> tuple[list[Shot], str, list[str]]:
        """Durées par plan : durée naturelle du mouvement + part du temps libre.

        Si la somme des mouvements dépasse la durée demandée, le style est
        accéléré jusqu'à tenir (sans descendre sous le style « fast »).
        """
        notes = []
        style = STYLES[style_name]
        in_world = True
        naturals = []
        for it in intents:
            naturals.append(self.natural_seconds(it.action, style, from_world=in_world))
            if it.action in ("open_continent", "open_country", "zoom_to_place"):
                in_world = False
            if it.action in ("establish_world", "back_to_world"):
                in_world = True
        total_nat = sum(naturals)
        if target_s and total_nat > target_s * 0.92:
            factor = total_nat / (target_s * 0.85)
            style = style.faster(factor)
            naturals = [n / factor for n in naturals]
            notes.append(f"Mouvements accélérés ×{factor:.2f} pour tenir {target_s:.0f} s.")
            style_name = f"{style_name}@{factor:.2f}"
        free = max(0.0, (target_s or total_nat * 1.3) - sum(naturals))
        weights = sum(it.weight for it in intents) or 1.0
        shots = []
        for i, (it, nat) in enumerate(zip(intents, naturals)):
            duration = round(nat + free * it.weight / weights, 2)
            shots.append(Shot(f"s{i + 1:02d}", it.action, it.params, duration, self.describe(it)))
        return shots, style_name, notes

    def describe(self, it: Intent) -> str:
        p, a = it.params, it.action
        country = lambda: self.site.country_name(p["country"]) if p.get("country") else "?"  # noqa: E731
        place = str(p.get("place") or "").replace("@tour:", "la zone ")
        if a == "open_continent":
            cont = p.get("continent", "")
            names = {"europe": "l'Europe", "africa": "l'Afrique", "asia": "l'Asie", "oceania": "l'Océanie",
                     "north-america": "l'Amérique du Nord", "south-america": "l'Amérique du Sud"}
            return f"Zoom progressif vers {names.get(cont, cont)}"
        if a == "open_country":
            return f"Descente vers {country()}"
        if a == "zoom_to_place":
            return f"Zoom vers {place}"
        if a == "pan_to_place":
            return f"Déplacement vers {place}"
        if a == "fit_country":
            return f"Retour à la vue de {country()}"
        if a == "open_saint":
            q = str(p.get("query") or "")
            return "Fiche d'un saint" if q.startswith("@") else f"Fiche : {q}"
        if a == "century_filter":
            return f"Saints du {p.get('century')}e siècle"
        if a == "calendar":
            return f"Calendrier : {p.get('day')}"
        if a == "open_apparition":
            return f"Apparition : {p.get('name')}"
        return ACTIONS[a]

    # --------------------------------------------------------------- API

    async def plan(self, request: str, defaults: dict | None = None) -> Scenario:
        defaults = defaults or {}
        target = parse_duration(request) or defaults.get("target_s")
        aspect = parse_aspect(request) or defaults.get("aspect", "16:9")
        resolution = parse_resolution(request) or defaults.get("resolution")
        style = parse_style(request) or defaults.get("style") or "documentary"
        intents, notes = [], []
        if self.use_llm:
            try:
                intents = await self._llm_intents(request)
                notes.append("Découpage proposé par Claude, vérifié par l'agent.")
            except Exception as exc:  # noqa: BLE001
                log.info("Planificateur IA indisponible (%s) : règles locales.", exc)
                intents = []
        if not intents:
            intents, notes2 = await self.intents_from_text(request)
            notes += notes2
        if not intents:
            intents = [Intent("establish_world", {}, 1), Intent("open_country", {"country": "FRA"}, 1.2),
                       Intent("open_saint", {"query": "@interesting", "country": "FRA"}, 0.8),
                       Intent("show_profile", {}, 2)]
        if intents[0].action not in ("establish_world",):
            intents.insert(0, Intent("establish_world", {}, 0.4))
        if intents[-1].action not in ("hold", "show_profile"):
            intents.append(Intent("hold", {}, 0.5))
        shots, style_used, notes3 = self.schedule(intents, style, target)
        title = request.strip().split(".")[0][:80]
        return Scenario(request, shots, style_used, aspect, resolution, target, title, notes + notes3)

    async def _llm_intents(self, request: str) -> list[Intent]:
        import anthropic

        client = anthropic.AsyncAnthropic()
        schema = {
            "type": "object",
            "properties": {"shots": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": sorted(ACTIONS)},
                    "country": {"type": "string"}, "continent": {"type": "string"},
                    "place": {"type": "string"}, "query": {"type": "string"},
                    "century": {"type": "integer"}, "day": {"type": "string"},
                    "weight": {"type": "number"},
                },
                "required": ["action", "country", "continent", "place", "query", "century", "day", "weight"],
                "additionalProperties": False}}},
            "required": ["shots"], "additionalProperties": False,
        }
        prompt = (
            "Découpe cette demande de vidéo SanctiMaps en plans. Actions possibles : "
            + "; ".join(f"{k} = {v}" for k, v in ACTIONS.items())
            + ". Champs vides (\"\" ou 0) si sans objet. country = nom du pays en français. "
              "query = nom du saint, ou \"@interesting\" pour choisir une fiche riche. "
              "weight = importance relative du plan (0.2 à 2). N'invente aucun saint ni lieu "
              "absent de la demande.\n\nDemande : " + request
        )
        response = await client.beta.messages.create(
            model=self.model, max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": prompt}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError("refus")
        data = json.loads(next(b.text for b in response.content if b.type == "text"))
        intents = []
        for s in data["shots"]:
            params: dict = {}
            if s["country"]:
                iso = self.site.find_country(s["country"])
                if not iso:
                    raise ValueError(f"pays inconnu du site : {s['country']}")
                params["country"] = iso
            if s["continent"]:
                cid = CONTINENT_WORDS.get(fold(s["continent"]), s["continent"])
                if cid not in self.site.continent_by_id:
                    raise ValueError(f"continent inconnu : {s['continent']}")
                params["continent"] = cid
            if s["place"]:
                params["place"] = s["place"]
            if s["query"]:
                params["query"] = s["query"]
            if s["century"]:
                params["century"] = s["century"]
            if s["day"]:
                params["day"] = s["day"]
            if s["action"] == "open_apparition":
                params["name"] = s["place"] or s["query"]
            intents.append(Intent(s["action"], params, max(0.2, min(2.0, s["weight"] or 1))))
        return intents
