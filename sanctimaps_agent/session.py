"""Mémoire de session : ce que l'agent sait de la vue en cours."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class SessionMemory:
    current_url: str | None = None
    current_map_state: str | None = None
    current_zoom: float | None = None  # rapport au cadrage d'arrivée du niveau
    current_view: str | None = None  # world | continent | country
    selected_continent: str | None = None
    selected_country: str | None = None  # ISO3
    selected_country_name: str | None = None
    selected_place: str | None = None
    selected_saint: str | None = None
    current_mode: str = "saints"  # saints | apparitions | miracles
    current_century: int | None = None
    last_action: str | None = None
    last_scenario: object | None = None
    last_video: str | None = None
    history: list[str] = field(default_factory=list)

    def record(self, action: str) -> None:
        self.last_action = action
        self.history.append(action)
        del self.history[:-50]

    def describe(self) -> dict:
        data = asdict(self)
        data.pop("last_scenario", None)
        return data
