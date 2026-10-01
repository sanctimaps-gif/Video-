"""Navigateur piloté et horloge virtuelle.

Le rendu vidéo est « image exacte » : pendant l'enregistrement, le temps de la
page ne s'écoule que lorsque l'agent le fait avancer. Chaque image de la vidéo
correspond à un pas de temps précis (1/30 s par défaut), quelle que soit la
vitesse de la machine. Une machine lente produit la même vidéo, plus lentement.

Seuls ``requestAnimationFrame`` et ``performance.now`` sont virtualisés : ce
sont eux qui animent la carte de SanctiMaps. Réseau, minuteries et transitions
CSS gardent le temps réel.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass

from playwright.async_api import Browser, BrowserContext, CDPSession, Page, Playwright, async_playwright

from .config import AgentConfig, OutputFormat

log = logging.getLogger(__name__)

VIRTUAL_TIME_JS = r"""
(() => {
  if (window.__sm) return;
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const nativeNow = performance.now.bind(performance);
  let manual = false, offset = 0, vnow = 0, nextId = 1e7;
  const queue = new Map();
  const now = () => (manual ? vnow : nativeNow() + offset);
  performance.now = now;
  window.requestAnimationFrame = (cb) => {
    if (!manual) return nativeRAF(() => cb(now()));
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (queue.has(id)) queue.delete(id); else nativeCAF(id);
  };
  window.__sm = {
    manual(on) {
      if (on && !manual) { vnow = now(); manual = true; }
      else if (!on && manual) {
        offset = vnow - nativeNow(); manual = false;
        const pending = [...queue.values()]; queue.clear();
        pending.forEach((cb) => nativeRAF(() => cb(now())));
      }
      return manual;
    },
    tick(dt) {
      vnow += dt;
      const pending = [...queue.values()]; queue.clear();
      for (const cb of pending) { try { cb(vnow); } catch (e) { console.error(e); } }
      return queue.size;
    },
    pending() { return queue.size; },
    isManual() { return manual; },
  };
})();
"""


@dataclass
class FrameGrab:
    data: bytes
    virtual_ms: float


class BrowserAgent:
    """Chromium + une page SanctiMaps, avec l'horloge virtuelle installée."""

    def __init__(self, config: AgentConfig, fmt: OutputFormat):
        self.config = config
        self.format = fmt
        self._pw: Playwright | None = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self.cdp: CDPSession | None = None
        self.virtual_ms = 0.0
        self._carry = 0.0

    async def start(self) -> Page:
        self._pw = await async_playwright().start()
        self.browser = await self._pw.chromium.launch(
            headless=self.config.headless,
            args=["--hide-scrollbars", "--disable-features=Translate", "--font-render-hinting=none"],
        )
        await self.open_context()
        return self.page

    async def open_context(self) -> None:
        if self.context:
            await self.context.close()
        w, h = self.format.viewport
        self.context = await self.browser.new_context(
            viewport={"width": w, "height": h},
            device_scale_factor=self.format.device_scale_factor,
            locale=self.config.locale,
            timezone_id="Europe/Paris",
            color_scheme="light",
            service_workers="block",
        )
        await self.context.add_init_script(VIRTUAL_TIME_JS)
        self.page = await self.context.new_page()
        self.page.set_default_timeout(self.config.action_timeout_s * 1000)
        self.cdp = await self.context.new_cdp_session(self.page)
        self.virtual_ms = 0.0

    async def resize(self, fmt: OutputFormat) -> None:
        """Change de format : nouvelle fenêtre aux bonnes proportions."""
        self.format = fmt
        await self.open_context()

    async def close(self) -> None:
        for closer in (self.context, self.browser):
            try:
                if closer:
                    await closer.close()
            except Exception:  # noqa: BLE001 - fermeture au mieux
                pass
        if self._pw:
            await self._pw.stop()

    # ------------------------------------------------------------------ temps

    async def set_manual_time(self, on: bool) -> None:
        await self.page.evaluate("(on) => window.__sm && window.__sm.manual(on)", on)

    async def tick(self, dt_ms: float) -> int:
        """Fait avancer l'horloge des animations de ``dt_ms`` et exécute une image."""
        self.virtual_ms += dt_ms
        return await self.page.evaluate("(dt) => window.__sm ? window.__sm.tick(dt) : 0", dt_ms)

    async def grab(self) -> bytes:
        shot = await self.cdp.send(
            "Page.captureScreenshot",
            {"format": "jpeg", "quality": self.config.jpeg_quality, "optimizeForSpeed": True},
        )
        return base64.b64decode(shot["data"])

    async def screenshot_png(self) -> bytes:
        return await self.page.screenshot(type="png")

    async def real_pause(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
