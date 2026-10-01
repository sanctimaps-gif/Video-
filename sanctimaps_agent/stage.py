"""La « scène » : horloge virtuelle + caméra.

Tout ce qui fait passer du temps passe par ici. Pendant l'enregistrement,
chaque pas produit une image ; hors enregistrement, le temps avance par grands
pas, sans capture, pour préparer un plan le plus vite possible.
"""

from __future__ import annotations

import asyncio

from .browser import BrowserAgent
from .recorder import FrameRecorder


class Stage:
    def __init__(self, browser: BrowserAgent, recorder: FrameRecorder | None, fps: int = 30):
        self.browser = browser
        self.recorder = recorder
        self.fps = fps
        self.state_label = "UNKNOWN"
        self.frames_this_segment = 0

    @property
    def frame_ms(self) -> float:
        return 1000.0 / self.fps

    @property
    def recording(self) -> bool:
        return bool(self.recorder and self.recorder.active)

    async def frame(self, tag: str = "action", virtual_ms: float | None = None) -> None:
        """Une image : l'horloge avance, la page se redessine, la caméra capture."""
        await self.browser.tick(self.frame_ms if virtual_ms is None else virtual_ms)
        if self.recording:
            self.recorder.add(await self.browser.grab(), tag, self.state_label)
            self.frames_this_segment += 1
        else:
            # Hors caméra, laisser respirer la boucle (réseau, minuteries).
            await asyncio.sleep(0.005)

    async def hold(self, seconds: float, tag: str = "hold") -> None:
        if seconds <= 0:
            return
        if not self.recording:
            await self.browser.tick(seconds * 1000)
            return
        for _ in range(max(1, round(seconds * self.fps))):
            await self.frame(tag)

    async def poll_step(self) -> None:
        """Un pas d'attente : une image si l'on filme, un court délai réel sinon."""
        if self.recording:
            await self.frame("wait")
        else:
            await self.browser.tick(50)
            await asyncio.sleep(0.03)

    def seconds_to_frames(self, seconds: float) -> int:
        return max(1, round(seconds * self.fps))
