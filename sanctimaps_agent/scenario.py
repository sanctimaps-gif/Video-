"""Scénario vidéo : une suite de plans, chacun avec une action et une durée."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

# Vocabulaire fermé des actions qu'un plan peut porter.
ACTIONS = {
    "establish_world": "Vue mondiale stable",
    "open_continent": "Descente vers un continent",
    "open_country": "Descente vers un pays",
    "zoom_to_place": "Zoom progressif vers un lieu",
    "pan_to_place": "Déplacement vers un lieu",
    "zoom_in": "Zoom avant",
    "zoom_out": "Zoom arrière",
    "pan": "Déplacement",
    "fit_country": "Retour à la vue du pays",
    "back_to_world": "Retour à la vue mondiale",
    "open_saint": "Ouverture d'une fiche",
    "open_marker": "Ouverture d'un repère de la carte",
    "show_profile": "Lecture de la fiche",
    "close_profile": "Fermeture de la fiche",
    "century_filter": "Filtre par siècle",
    "calendar": "Calendrier des fêtes",
    "apparitions_on": "Passage en mode apparitions",
    "apparitions_off": "Retour aux saints",
    "open_apparition": "Ouverture d'une apparition",
    "hold": "Pause",
    "level_up": "Remonter d'un niveau",
    "miracles_on": "Mode miracles",
    "show_lieux": "Lieux marqués par le saint",
    "show_croises": "Saints qu'il a pu croiser",
    "search_list": "Recherche",
    "close_panel": "Fermeture du panneau",
    "frame_view": "Cadrage montré à la main",
    "open_list_item": "Fiche choisie dans la liste",
}


@dataclass
class Shot:
    id: str
    action: str
    params: dict = field(default_factory=dict)
    duration_s: float = 3.0
    label: str = ""

    def __post_init__(self):
        if self.action not in ACTIONS:
            raise ValueError(f"Action inconnue : {self.action}")
        if not self.label:
            self.label = ACTIONS[self.action]


@dataclass
class Scenario:
    request: str
    shots: list[Shot]
    style: str = "documentary"
    aspect: str = "16:9"
    resolution: str | None = None
    target_s: float | None = None
    title: str = "SanctiMaps"
    notes: list[str] = field(default_factory=list)

    @property
    def total_s(self) -> float:
        return sum(s.duration_s for s in self.shots)

    def timeline(self) -> str:
        lines, t = [], 0.0
        for shot in self.shots:
            end = t + shot.duration_s
            lines.append(f"{t:>5.1f}–{end:>5.1f} s  {shot.label}")
            t = end
        head = f"« {self.title} » — {self.aspect}, style {self.style}, {self.total_s:.0f} s"
        return "\n".join([head, *lines, *[f"  note : {n}" for n in self.notes]])

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

    @classmethod
    def from_dict(cls, data: dict) -> "Scenario":
        shots = [Shot(**s) for s in data["shots"]]
        return cls(**{**data, "shots": shots})
