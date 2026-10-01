"""Réglages : formats de sortie, styles de mouvement, délais."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace

DEFAULT_URL = os.environ.get("SANCTIMAPS_URL", "https://sanctimaps.fr/")


@dataclass(frozen=True)
class OutputFormat:
    """Un format de sortie.

    La fenêtre du navigateur prend directement les proportions du format : la
    vidéo verticale n'est pas un recadrage d'une vidéo horizontale, c'est la
    carte elle-même qui est mise en page en portrait.
    """

    name: str
    viewport: tuple[int, int]
    output: tuple[int, int]

    @property
    def device_scale_factor(self) -> float:
        return self.output[0] / self.viewport[0]


# Le viewport reste assez grand pour que la carte soit exploitable ; la
# résolution de sortie se règle par le facteur d'échelle (rendu natif en 4K,
# pas un agrandissement).
FORMATS: dict[str, OutputFormat] = {
    "16:9": OutputFormat("16:9", (1920, 1080), (1920, 1080)),
    "16:9-720p": OutputFormat("16:9-720p", (1920, 1080), (1280, 720)),
    "16:9-4k": OutputFormat("16:9-4k", (1920, 1080), (3840, 2160)),
    "9:16": OutputFormat("9:16", (1080, 1920), (1080, 1920)),
    "9:16-4k": OutputFormat("9:16-4k", (1080, 1920), (2160, 3840)),
    "1:1": OutputFormat("1:1", (1080, 1080), (1080, 1080)),
}


def resolve_format(aspect: str = "16:9", resolution: str | None = None) -> OutputFormat:
    """« 9:16 » + « 4k » → le format correspondant (ou le plus proche)."""
    key = aspect
    if resolution in ("720p", "4k"):
        key = f"{aspect}-{resolution}"
    if key in FORMATS:
        return FORMATS[key]
    base = FORMATS[aspect]
    if resolution == "720p":
        w, h = base.viewport
        return OutputFormat(key, base.viewport, (w * 2 // 3 // 2 * 2, h * 2 // 3 // 2 * 2))
    return base


@dataclass(frozen=True)
class MotionStyle:
    """Comment la caméra bouge.

    ``transition_s`` est la durée à l'écran d'une transition animée par le site
    lui-même (monde → continent → pays) : son animation de 720 ms est rendue au
    ralenti, image par image, en faisant avancer l'horloge virtuelle plus
    lentement. Rien n'est inventé : ce sont les images du site.
    """

    name: str
    transition_s: float
    zoom_s_per_doubling: float
    pan_px_per_s: float
    hold_s: float
    reading_s_per_100_chars: float
    typing_chars_per_s: float
    settle_s: float = 0.3

    def slower(self, factor: float = 1.5) -> "MotionStyle":
        return replace(
            self,
            name=f"{self.name}-slow",
            transition_s=self.transition_s * factor,
            zoom_s_per_doubling=self.zoom_s_per_doubling * factor,
            pan_px_per_s=self.pan_px_per_s / factor,
            hold_s=self.hold_s * factor,
            typing_chars_per_s=self.typing_chars_per_s / factor,
        )

    def faster(self, factor: float = 1.5) -> "MotionStyle":
        return self.slower(1 / factor)


STYLES: dict[str, MotionStyle] = {
    "cinematic": MotionStyle("cinematic", 3.2, 1.6, 260, 1.8, 2.0, 7, 0.5),
    "documentary": MotionStyle("documentary", 2.2, 1.1, 380, 2.2, 3.0, 9, 0.4),
    "fast": MotionStyle("fast", 1.0, 0.55, 800, 0.8, 1.2, 18, 0.2),
    "slow": MotionStyle("slow", 4.5, 2.4, 170, 2.6, 3.0, 5, 0.6),
    "educational": MotionStyle("educational", 2.0, 1.2, 340, 2.8, 4.5, 8, 0.5),
}


def custom_style(base: str = "documentary", **overrides) -> MotionStyle:
    return replace(STYLES[base], name="custom", **overrides)


@dataclass
class AgentConfig:
    url: str = DEFAULT_URL
    fps: int = 30
    locale: str = "fr-FR"
    load_timeout_s: float = 60.0
    action_timeout_s: float = 15.0
    max_retries: int = 3
    jpeg_quality: int = 92
    crf: int = 18
    work_dir: str = "runs"
    headless: bool = True
    # Réserve les captures d'écran analysées par l'IA (vision) aux cas où le
    # DOM ne suffit pas. Nécessite ANTHROPIC_API_KEY.
    vision_enabled: bool = True
    vision_model: str = "claude-opus-5-5"
    llm_planner_enabled: bool = True
    extra: dict = field(default_factory=dict)
