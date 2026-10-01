"""États de SanctiMaps tels que l'agent les observe."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class SiteState(str, Enum):
    LOADING = "LOADING"
    INTRO_OPEN = "INTRO_OPEN"  # la carte est prête, la présentation la couvre encore
    MAP_READY = "MAP_READY"  # planisphère
    MAP_MOVING = "MAP_MOVING"
    MAP_ZOOMING = "MAP_ZOOMING"
    CONTINENT_VIEW = "CONTINENT_VIEW"
    COUNTRY_VIEW = "COUNTRY_VIEW"
    PLACE_VIEW = "PLACE_VIEW"
    SAINT_SELECTED = "SAINT_SELECTED"  # liste « N saints ici » ouverte
    SAINT_PANEL_OPEN = "SAINT_PANEL_OPEN"  # fiche ouverte, contenu en cours
    SAINT_PROFILE_OPEN = "SAINT_PROFILE_OPEN"  # fiche entièrement affichée
    CENTURY_VIEW = "CENTURY_VIEW"
    CALENDAR_VIEW = "CALENDAR_VIEW"
    APPARITIONS_MODE = "APPARITIONS_MODE"
    SEARCH_ACTIVE = "SEARCH_ACTIVE"
    ERROR = "ERROR"
    UNKNOWN = "UNKNOWN"


@dataclass
class Snapshot:
    """Ce que la page montre à un instant donné, lu dans le DOM."""

    state: SiteState
    flags: set[SiteState] = field(default_factory=set)
    mode: str | None = None  # world | continent | country
    trail: list[str] = field(default_factory=list)
    transform: tuple[float, float, float] | None = None  # (k, x, y)
    corpus: str | None = None  # saints | apparitions | miracles
    fiche_name: str | None = None
    hint: str | None = None
    panel_section: str | None = None
    raw: dict = field(default_factory=dict)

    def has(self, state: SiteState) -> bool:
        return self.state == state or state in self.flags

    @property
    def country(self) -> str | None:
        return self.trail[2] if self.mode == "country" and len(self.trail) > 2 else None

    @property
    def continent(self) -> str | None:
        return self.trail[1] if len(self.trail) > 1 else None
