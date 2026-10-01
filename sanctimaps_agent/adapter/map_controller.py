"""MapController : les mouvements de caméra sur la carte de SanctiMaps.

Deux sortes de mouvements :

* les **transitions du site** (monde → continent → pays, recadrage « ⤢ ») :
  l'agent déclenche l'action comme un lecteur (clic), puis rend l'animation du
  site au ralenti en faisant avancer l'horloge virtuelle par petits pas ;
* les **mouvements libres** (zoom, déplacement) au continent et au pays :
  molette et glisser de souris, répartis sur des dizaines d'images avec une
  courbe d'accélération douce — jamais « clic-clic-clic ».

Après chaque mouvement : attente de la fin d'animation, vérification que la
carte ne bouge plus, courte pause, image de référence.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

from ..config import MotionStyle
from ..projection import project
from ..stage import Stage
from ..sync import Synchronizer
from .knowledge import SAFE_POINT_JS, SANCTIMAPS_ADAPTER

log = logging.getLogger(__name__)

WHEEL_COEF = SANCTIMAPS_ADAPTER["wheel_zoom_coef"]
TRANSITION_MS = SANCTIMAPS_ADAPTER["transition_ms"]


def ease_in_out(t: float) -> float:
    """Courbe douce (cosinus) : départ et arrivée sans à-coup."""
    t = min(1.0, max(0.0, t))
    return 0.5 - 0.5 * math.cos(math.pi * t)


@dataclass
class MoveResult:
    ok: bool
    requested: float
    achieved: float
    note: str = ""


class MapController:
    def __init__(self, page, stage: Stage, sync: Synchronizer, style: MotionStyle):
        self.page = page
        self.stage = stage
        self.sync = sync
        self.style = style
        self.base_k: float | None = None  # échelle d'arrivée du niveau courant
        self.reference_frame: bytes | None = None

    # ------------------------------------------------------------ géométrie

    async def geometry(self) -> dict:
        snap = await self.sync.snapshot()
        left, top, width, height = snap.raw.get("mapRect") or (0, 0, 0, 0)
        return {"k": snap.transform[0], "x": snap.transform[1], "y": snap.transform[2],
                "left": left, "top": top, "width": width, "height": height, "mode": snap.mode}

    async def to_page(self, px: float, py: float) -> tuple[float, float]:
        g = await self.geometry()
        return g["left"] + g["x"] + px * g["k"], g["top"] + g["y"] + py * g["k"]

    async def center(self) -> tuple[float, float]:
        g = await self.geometry()
        return g["left"] + g["width"] / 2, g["top"] + g["height"] / 2

    async def safe_point(self, near: tuple[float, float] | None = None) -> tuple[float, float]:
        pt = await self.page.evaluate(SAFE_POINT_JS, list(near) if near else [None, None])
        return float(pt[0]), float(pt[1])

    async def zoom_ratio(self) -> float | None:
        g = await self.geometry()
        return g["k"] / self.base_k if self.base_k else None

    # --------------------------------------------------- transitions du site

    async def site_transition(self, trigger, seconds: float | None = None, tag: str = "transition") -> None:
        """Déclenche une transition animée du site et la filme au ralenti.

        ``trigger`` est une coroutine (le clic). L'animation du site dure 720 ms ;
        elle est échantillonnée sur ``seconds`` de vidéo.
        """
        seconds = self.style.transition_s if seconds is None else seconds
        frames = self.stage.seconds_to_frames(seconds)
        dt = TRANSITION_MS / frames
        await trigger()
        for _ in range(frames):
            await self.stage.frame(tag, virtual_ms=dt)
        # L'animation peut avoir été relancée (chargement du contour fin) :
        # on la laisse finir à vitesse ralentie plutôt que de sauter.
        guard = 0
        while (await self.sync.snapshot()).raw.get("rafPending") and guard < frames:
            await self.stage.frame(tag, virtual_ms=dt)
            guard += 1
        await self.stabilize()
        self.base_k = (await self.geometry())["k"]

    async def stabilize(self) -> None:
        """Attendre que la carte ne bouge plus, marquer une courte pause, capturer."""
        await self.sync.wait_until_map_stable()
        await self.stage.hold(self.style.settle_s, tag="hold")
        if not self.stage.recording:
            self.reference_frame = await self.stage.browser.grab()

    # ------------------------------------------------------------------ zoom

    async def can_zoom_freely(self) -> bool:
        return (await self.sync.snapshot()).mode in ("continent", "country")

    async def wheel_zoom(self, factor: float, anchor: tuple[float, float] | None = None,
                         seconds: float | None = None) -> MoveResult:
        """Zoom progressif centré sur ``anchor`` (coordonnées de page).

        La molette est répartie sur toutes les images : la variation d'échelle
        suit une courbe douce en espace logarithmique (ce que l'œil perçoit
        comme une vitesse constante).
        """
        if not await self.can_zoom_freely():
            return MoveResult(False, factor, 1.0, "zoom libre indisponible au niveau monde")
        if seconds is None:
            seconds = max(0.6, abs(math.log2(factor)) * self.style.zoom_s_per_doubling)
        frames = self.stage.seconds_to_frames(seconds)
        before = (await self.geometry())["k"]
        anchor = await self.safe_point(anchor or await self.center())
        await self.page.mouse.move(*anchor)
        total = math.log(factor)
        done = 0.0
        for i in range(1, frames + 1):
            target = total * ease_in_out(i / frames)
            step, done = target - done, target
            if abs(step) > 1e-9:
                await self.page.mouse.wheel(0, -step / WHEEL_COEF)
            await self.stage.frame("action")
        await self.stabilize()
        after = (await self.geometry())["k"]
        achieved = after / before
        ok = abs(math.log(achieved) - total) < 0.15 or (factor > 1) == (achieved > 1.0001)
        note = "" if abs(math.log(achieved) - total) < 0.15 else "zoom borné par le site"
        return MoveResult(ok, factor, achieved, note)

    async def zoom_in(self, factor: float = 2.0, anchor=None) -> MoveResult:
        return await self.wheel_zoom(factor, anchor)

    async def zoom_out(self, factor: float = 2.0, anchor=None) -> MoveResult:
        return await self.wheel_zoom(1 / factor, anchor)

    async def fit(self) -> None:
        """Revient au cadrage d'arrivée (bouton « ⤢ » du site), au ralenti."""
        button = self.page.locator(".zoom__fit")
        if await button.count() and await button.is_visible() and await button.is_enabled():
            await self.site_transition(lambda: button.click())

    # ------------------------------------------------------------ déplacement

    async def drag(self, dx: float, dy: float, seconds: float | None = None) -> MoveResult:
        """Déplacement fluide de la carte : un seul geste de souris, étalé."""
        dist = math.hypot(dx, dy)
        if dist < 8:
            return MoveResult(True, dist, 0.0, "déplacement négligeable")
        if seconds is None:
            seconds = max(0.6, dist / self.style.pan_px_per_s)
        frames = self.stage.seconds_to_frames(seconds)
        g = await self.geometry()
        # Point de départ : décalé à l'opposé du geste, pour que la souris
        # reste dans la carte du début à la fin.
        cx, cy = g["left"] + g["width"] / 2, g["top"] + g["height"] / 2
        sx = min(max(cx - dx / 2, g["left"] + 10), g["left"] + g["width"] - 10)
        sy = min(max(cy - dy / 2, g["top"] + 10), g["top"] + g["height"] - 10)
        sx, sy = await self.safe_point((sx, sy))
        before = (g["x"], g["y"])
        await self.page.mouse.move(sx, sy)
        await self.page.mouse.down()
        # Premier pas franc (> seuil de clic) pour que le site lise un glisser.
        threshold = SANCTIMAPS_ADAPTER["drag_threshold_px"] + 1
        try:
            for i in range(1, frames + 1):
                p = ease_in_out(i / frames)
                mx, my = dx * p, dy * p
                if math.hypot(mx, my) < threshold and i < frames:
                    ux, uy = dx / dist, dy / dist
                    mx, my = ux * threshold, uy * threshold
                await self.page.mouse.move(sx + mx, sy + my)
                await self.stage.frame("action")
        finally:
            await self.page.mouse.up()
        await self.stabilize()
        g2 = await self.geometry()
        moved = math.hypot(g2["x"] - before[0], g2["y"] - before[1])
        return MoveResult(moved > 0.5 * dist, dist, moved, "" if moved > 0.9 * dist else "déplacement borné par le site")

    async def pan(self, direction: str, fraction: float = 0.3) -> MoveResult:
        """pan_north / pan_south / pan_east / pan_west : on regarde vers ce point cardinal."""
        g = await self.geometry()
        amount_x, amount_y = g["width"] * fraction, g["height"] * fraction
        # Regarder vers le nord, c'est tirer la carte vers le bas.
        vectors = {"north": (0, amount_y), "south": (0, -amount_y),
                   "east": (-amount_x, 0), "west": (amount_x, 0)}
        dx, dy = vectors[direction]
        return await self.drag(dx, dy)

    async def pan_north(self, fraction: float = 0.3): return await self.pan("north", fraction)
    async def pan_south(self, fraction: float = 0.3): return await self.pan("south", fraction)
    async def pan_east(self, fraction: float = 0.3): return await self.pan("east", fraction)
    async def pan_west(self, fraction: float = 0.3): return await self.pan("west", fraction)

    async def pan_to_projected(self, px: float, py: float, seconds: float | None = None) -> MoveResult:
        target = await self.to_page(px, py)
        center = await self.center()
        return await self.drag(center[0] - target[0], center[1] - target[1], seconds)

    async def pan_to_coordinates(self, lat: float, lon: float) -> MoveResult:
        return await self.pan_to_projected(*project(lon, lat))

    async def pan_to_region(self, bbox: list[float]) -> MoveResult:
        return await self.pan_to_projected((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)

    # --------------------------------------------------- zooms composés

    async def zoom_to_projected(self, px: float, py: float, ratio: float) -> MoveResult:
        """Amène un point au centre puis s'en approche jusqu'à ``ratio`` × l'échelle d'arrivée."""
        await self.pan_to_projected(px, py)
        g = await self.geometry()
        base = self.base_k or g["k"]
        factor = (base * ratio) / g["k"]
        anchor = await self.to_page(px, py)
        if abs(math.log(factor)) < 0.05:
            return MoveResult(True, factor, 1.0, "déjà à l'échelle voulue")
        return await self.wheel_zoom(factor, anchor)

    async def zoom_to_coordinates(self, lat: float, lon: float, ratio: float = 4.0) -> MoveResult:
        return await self.zoom_to_projected(*project(lon, lat), ratio)

    async def zoom_to_region(self, bbox: list[float], padding: float = 0.1) -> MoveResult:
        """Cadre une boîte (coordonnées projetées) : déplacement puis zoom."""
        g = await self.geometry()
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        bw, bh = max(1.0, bbox[2] - bbox[0]), max(1.0, bbox[3] - bbox[1])
        k_target = min(g["width"] / bw, g["height"] / bh) * (1 - padding)
        await self.pan_to_projected(cx, cy)
        g = await self.geometry()
        anchor = await self.to_page(cx, cy)
        return await self.wheel_zoom(k_target / g["k"], anchor)
