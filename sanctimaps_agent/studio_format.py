"""Scénarios exportés par le studio en ligne (studio/*.js) → scénarios Python.

Le studio et l'agent partagent le même vocabulaire d'actions ; seuls quelques
noms de champs diffèrent (camelCase côté navigateur).
"""

from __future__ import annotations

import json
import re

from .scenario import ACTIONS, Scenario, Shot

PARAM_NAMES = {"resolvedPlace": "resolved_place"}


def extract_json(text: str) -> dict:
    """Le premier bloc ```json …``` d'un texte (corps d'issue), ou le texte entier."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    return json.loads(m.group(1) if m else text)


def from_studio(data: dict) -> Scenario:
    shots = []
    for i, raw in enumerate(data.get("shots", [])):
        action = raw["action"]
        if action not in ACTIONS:
            raise ValueError(f"action inconnue : {action}")
        params = {PARAM_NAMES.get(k, k): v for k, v in (raw.get("params") or {}).items() if v not in (None, "")}
        duration = float(raw.get("duration", raw.get("duration_s", 3.0)))
        if not 0.2 <= duration <= 120:
            raise ValueError(f"durée hors bornes pour {action} : {duration}")
        shots.append(Shot(raw.get("id") or f"s{i + 1:02d}", action, params, duration, raw.get("label") or ""))
    if not shots:
        raise ValueError("scénario vide")
    if sum(s.duration_s for s in shots) > 300:
        raise ValueError("scénario de plus de 5 minutes")
    style = data.get("style") or "documentary"
    speed = float(data.get("speed") or 1)
    if abs(speed - 1) > 1e-3:
        style = f"{style}@{speed:.3f}"
    aspect = data.get("aspect") if data.get("aspect") in ("16:9", "9:16", "1:1") else "16:9"
    return Scenario(data.get("request") or "", shots, style, aspect, data.get("resolution"),
                    sum(s.duration_s for s in shots), data.get("title") or "SanctiMaps")
