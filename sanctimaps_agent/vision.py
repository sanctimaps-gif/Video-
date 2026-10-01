"""Compréhension visuelle — système de secours.

Ordre de priorité de l'agent : DOM / accessibilité → sélecteurs connus →
coordonnées calculées → vision. La vision n'intervient que lorsque les trois
premiers ont échoué, ou pour contrôler la qualité d'une image.

Deux niveaux :
* ``heuristics`` : mesures locales (image vide, uniforme, floue), sans réseau ;
* Claude (si ``ANTHROPIC_API_KEY`` est défini) : description d'une capture et
  localisation d'un élément, avec une réponse JSON contrainte par un schéma.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os

log = logging.getLogger(__name__)

DESCRIBE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "state": {"type": "string", "enum": [
            "LOADING", "INTRO_OPEN", "MAP_READY", "CONTINENT_VIEW", "COUNTRY_VIEW", "PLACE_VIEW",
            "SAINT_SELECTED", "SAINT_PROFILE_OPEN", "SEARCH_ACTIVE", "CALENDAR_VIEW",
            "APPARITIONS_MODE", "ERROR", "UNKNOWN"]},
        "visible_texts": {"type": "array", "items": {"type": "string"}},
        "problems": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "state", "visible_texts", "problems"],
    "additionalProperties": False,
}

LOCATE_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["found", "x", "y", "reason"],
    "additionalProperties": False,
}

SYSTEM = (
    "Tu analyses des captures d'écran de SanctiMaps (https://sanctimaps.fr), une carte mondiale "
    "des saints de l'Église catholique : planisphère, niveaux continent et pays, repères en croix, "
    "fiche du saint dans la moitié basse, panneau latéral (recherche, saint du jour), bascule "
    "Saints / Apparitions / Miracles. Décris uniquement ce qui est visible ; n'invente aucun "
    "contenu (nom, date, lieu) qui ne figure pas à l'écran."
)


class VisionAnalyzer:
    def __init__(self, model: str = "claude-opus-5-5", enabled: bool = True):
        self.model = model
        self.client = None
        if enabled and (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            try:
                import anthropic

                self.client = anthropic.AsyncAnthropic()
            except ImportError:
                log.info("Paquet anthropic absent : vision IA désactivée.")

    @property
    def available(self) -> bool:
        return self.client is not None

    async def _ask(self, png: bytes, prompt: str, schema: dict) -> dict:
        response = await self.client.beta.messages.create(
            model=self.model,
            max_tokens=4000,
            system=SYSTEM,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                             "data": base64.standard_b64encode(png).decode()}},
                {"type": "text", "text": prompt},
            ]}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError("analyse visuelle refusée")
        text = next(b.text for b in response.content if b.type == "text")
        return json.loads(text)

    async def describe(self, png: bytes) -> dict:
        return await self._ask(png, "Quel est l'état de SanctiMaps sur cette capture ? Liste les problèmes "
                                    "visibles (écran vide, chargement, panneau coupé, élément mal placé).",
                               DESCRIBE_SCHEMA)

    async def locate(self, png: bytes, target: str) -> dict:
        w, h = png_size(png)
        return await self._ask(
            png, f"Donne les coordonnées en pixels (image de {w}×{h}) du centre de : {target}. "
                 "found=false si ce n'est pas visible.", LOCATE_SCHEMA)


def png_size(png: bytes) -> tuple[int, int]:
    from PIL import Image

    with Image.open(io.BytesIO(png)) as im:
        return im.size


def frame_stats(jpeg: bytes, size: int = 96):
    """Luminance moyenne, écart-type et netteté d'une image réduite."""
    import numpy as np
    from PIL import Image

    with Image.open(io.BytesIO(jpeg)) as im:
        g = np.asarray(im.convert("L").resize((size, size * im.height // im.width)), dtype=np.float32)
    lap = np.abs(np.diff(g, axis=0)).mean() + np.abs(np.diff(g, axis=1)).mean()
    return {"mean": float(g.mean()), "std": float(g.std()), "edges": float(lap), "array": g}
