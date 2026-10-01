"""Compréhension des commandes en français.

Une commande est soit une action immédiate sur la carte (« Va en France »),
soit une demande de vidéo (« Fais une vidéo de 30 secondes… »), soit une
retouche de la dernière vidéo (« Fais-la plus lente »).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .adapter.site_data import fold
from .planner import parse_aspect, parse_century


@dataclass
class Command:
    intent: str
    args: dict = field(default_factory=dict)
    text: str = ""


RULES: list[tuple[str, str]] = [
    # retouches de la dernière vidéo — avant « vidéo » générique
    (r"\b(recommence|refais|refaire|reprends?)\b.*\b(derniere|seule) sequence|\bderniere sequence\b", "redo_last"),
    (r"\b(refais|recommence|refaire)\b.*\b(fluide|doux|douce)", "redo_smoother"),
    (r"\bplus lente?\b|\bralenti", "redo_slower"),
    (r"\bplus rapide\b|\baccelere", "redo_faster"),
    (r"\b(version|format)\b.*\b(verticale?|portrait|carree?|horizontale?)\b|\bfais[- ]la (en )?(verticale?|carree?|horizontale?)", "redo_aspect"),
    (r"\b(fais|cree|realise|genere|tourne|produis)\b.*\b(video|film|clip|reel|short)\b|\bvideo (de|d')\s*\d", "video"),
    (r"\b(commence|demarre|lance)\b.*\benregistr|\bfilme\b|^enregistre", "record_start"),
    (r"\b(arrete|stoppe|termine|fin)\b.*\benregistr|^coupe[z]?\b", "record_stop"),
    (r"\bouvre sanctimaps\b|^ouvre (le )?site\b|^(re)?charge\b", "open"),
    (r"\bmode apparitions?\b|\bpasse (en|aux) apparitions?\b|\baffiche les apparitions\b", "apparitions_on"),
    (r"\b(quitte|sors? du) mode apparitions?\b|\b(reviens?|retour) aux saints\b|\bmode saints\b", "apparitions_off"),
    (r"\bmiracles?\b.*\bmode\b|\bmode miracles?\b", "miracles_on"),
    (r"\bcalendrier\b|\bsaint du jour\b|\bfetes? (aujourd|demain|hier|le \d|du \d)|\bfetes? (le|du) ", "calendar"),
    (r"\bsiecle\b", "century"),
    (r"\b(cherche|trouve|recherche)\b", "search"),
    (r"\b(ouvre|affiche|montre)\b.*\b(sa|la|cette) fiche\b|\bouvre (sa|la) fiche\b", "open_profile"),
    (r"\b(ferme|referme)\b.*\bfiche\b", "close_profile"),
    (r"\bzoom(e|er)? arriere\b|\bdezoom|\brecule\b|\bplus loin\b", "zoom_out"),
    (r"\bzoom(e|er)? (sur|vers)\b", "zoom_place"),
    (r"\bzoom(e|er)?\b.*\b(davantage|plus|encore|avant)\b|\brapproche[- ]toi\b|^zoome?$", "zoom_in"),
    (r"\b(va|aller|allons|deplace[- ]toi)\b.*\b(au|vers le|a l')?\s*(nord|sud|est|ouest)\b$", "pan"),
    (r"\b(vue (du )?monde|planisphere|reviens? au monde|monde entier)\b", "world"),
    (r"\bmontre(-moi)? les saints (de|du|d'|en)\b|\b(va|aller|allons|direction|emmene[- ]moi)\b", "go"),
    (r"\b(etat|ou en es[- ]tu|ou sommes[- ]nous|memoire)\b", "status"),
    (r"\b(aide|help|que sais[- ]tu faire)\b", "help"),
]


def parse_command(text: str) -> Command:
    t = fold(text.replace("’", "'"))
    for pattern, intent in RULES:
        if re.search(pattern, t):
            return Command(intent, extract_args(intent, text), text)
    return Command("unknown", {}, text)


def extract_args(intent: str, text: str) -> dict:
    t = fold(text)
    if intent == "redo_aspect":
        return {"aspect": parse_aspect(text) or "9:16"}
    if intent == "century":
        return {"century": parse_century(text)}
    if intent == "search":
        m = re.search(r"(?:cherche|trouve|recherche)\s+(?:moi\s+)?(.+)$", text.strip().rstrip(".!?"), re.I)
        return {"query": m.group(1).strip() if m else ""}
    if intent == "calendar":
        m = re.search(r"\b(\d{1,2}(?:er)?\s+\w+)", t)
        if "demain" in t:
            return {"day": "demain"}
        if "hier" in t:
            return {"day": "hier"}
        if m and re.search(r"(janv|fevr|mars|avri|mai|juin|juil|aout|sept|octo|nove|dece)", m.group(1)):
            return {"day": m.group(1)}
        return {"day": "aujourd'hui" if re.search(r"aujourd|fete|du jour", t) else None}
    if intent == "pan":
        return {"direction": {"nord": "north", "sud": "south", "est": "east", "ouest": "west"}[
            re.search(r"(nord|sud|est|ouest)\b", t).group(1)]}
    if intent in ("zoom_place", "go"):
        m = re.search(r"(?:zoome?r?\s+(?:sur|vers)|va\s+(?:en|au|aux|a|à|dans|vers)|aller\s+(?:en|au|aux|a|à)|"
                      r"allons\s+(?:en|au|aux|a|à)|direction|emm[eè]ne[- ]moi\s+(?:en|au|aux|a|à)|"
                      r"saints\s+(?:de|du|d'|d’|en|des))\s+(?:la |le |les |l'|l’)?(.+)$",
                      text.strip().rstrip(".!?"), re.I)
        return {"target": m.group(1).strip() if m else text.strip()}
    if intent in ("zoom_in", "zoom_out"):
        return {"factor": 3.0 if re.search(r"beaucoup|bien plus|fort", t) else 2.0}
    return {}


HELP = """Commandes reconnues (exemples) :
  Ouvre SanctiMaps. · Va en France. · Zoome sur Paris. · Montre les saints de France.
  Cherche saint Louis. · Ouvre sa fiche. · Ferme la fiche. · Fais un zoom arrière. · Zoome davantage.
  Montre-moi les saints du XIIe siècle. · Ouvre le calendrier. · Montre les saints fêtés aujourd'hui.
  Passe en mode apparitions. · Reviens aux saints.
  Commence l'enregistrement. · Arrête l'enregistrement.
  Fais une vidéo de 30 secondes sur les saints en France.
  Fais-la plus lente. · Fais une version verticale. · Recommence uniquement la dernière séquence.
  Refais la vidéo avec des mouvements plus fluides.
  État (mémoire de session) · Aide"""
