"""SanctiMapsVideoAgent : point d'entrée — une phrase en français, une action ou une vidéo."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from .adapter import SanctiMapsAdapter
from .adapter.apparitions import ApparitionsController
from .adapter.sanctimaps import ActionReport
from .browser import BrowserAgent
from .config import STYLES, AgentConfig, OutputFormat, resolve_format
from .director import Director, DirectorResult
from .executor import ShotExecutor
from .nlu import HELP, parse_command
from .planner import ScenarioPlanner
from .recorder import FrameRecorder
from .session import SessionMemory
from .stage import Stage
from .vision import VisionAnalyzer

log = logging.getLogger(__name__)


class SanctiMapsVideoAgent:
    def __init__(self, config: AgentConfig | None = None, style: str = "documentary"):
        self.config = config or AgentConfig()
        self.style_name = style
        self.memory = SessionMemory()
        self.vision = VisionAnalyzer(self.config.vision_model, self.config.vision_enabled)
        self.browser: BrowserAgent | None = None
        self.stage: Stage | None = None
        self.adapter: SanctiMapsAdapter | None = None
        self.executor: ShotExecutor | None = None
        self.planner: ScenarioPlanner | None = None
        self.director = Director(self)
        self.live_recorder: FrameRecorder | None = None
        self._opened = False

    # ----------------------------------------------------------- cycle de vie

    async def ensure_started(self, fmt: OutputFormat | None = None) -> None:
        fmt = fmt or (self.browser.format if self.browser else resolve_format("16:9"))
        if self.browser is None:
            self.browser = BrowserAgent(self.config, fmt)
            await self.browser.start()
            self._wire()
        elif self.browser.format != fmt:
            await self.browser.resize(fmt)
            self._wire()
            self._opened = False

    def _wire(self) -> None:
        recorder = self.stage.recorder if self.stage else None
        self.stage = Stage(self.browser, recorder, self.config.fps)
        self.adapter = SanctiMapsAdapter(self.browser.page, self.stage, self.config, STYLES[self.style_name],
                                         self.memory, self.vision)
        self.executor = ShotExecutor(self.adapter, self.config.max_retries)
        self.apparitions = ApparitionsController(self.adapter)
        self.planner = ScenarioPlanner(self.adapter.site, self.adapter.corpus, self.memory,
                                       self.config.llm_planner_enabled, self.config.vision_model)

    async def open(self) -> ActionReport:
        await self.ensure_started()
        rep = await self.adapter.open()
        self._opened = True
        return rep

    async def ensure_open(self) -> None:
        if not self._opened:
            await self.open()

    async def close(self) -> None:
        if self.browser:
            await self.browser.close()
            self.browser = None

    # ---------------------------------------------------------------- commandes

    async def handle(self, text: str, confirm=None) -> str:
        """Exécute une commande en français et rend un compte rendu lisible."""
        cmd = parse_command(text)
        i, args = cmd.intent, cmd.args
        if i == "help":
            return HELP
        if i == "status":
            return "\n".join(f"{k}: {v}" for k, v in self.memory.describe().items() if k != "history")

        if i == "video":
            result = await self.director.make(text, confirm=confirm)
            await self._reopen_after_director()
            return result.summary()
        if i in ("redo_slower", "redo_faster", "redo_aspect", "redo_smoother"):
            if not self.director.scenario:
                return "Il n'y a pas encore de vidéo à refaire."
            variant = self.director.variant(
                aspect=args.get("aspect") if i == "redo_aspect" else None,
                slower=1.4 if i == "redo_slower" else (1 / 1.4 if i == "redo_faster" else None),
                smoother=i == "redo_smoother")
            result = await self.director.make(variant, confirm=confirm)
            await self._reopen_after_director()
            return result.summary()
        if i == "redo_last":
            if not self.director.scenario:
                return "Il n'y a pas encore de vidéo à reprendre."
            result = await self.director.redo_last_sequence()
            await self._reopen_after_director()
            return result.summary()

        await self.ensure_open()
        a = self.adapter
        if i == "open":
            rep = await self.open()
        elif i == "record_start":
            run_dir = Path(self.config.work_dir) / ("live-" + time.strftime("%Y%m%d-%H%M%S"))
            self.live_recorder = FrameRecorder(run_dir, self.config.fps)
            self.stage.recorder = self.live_recorder
            self.live_recorder.begin("live01", "Enregistrement libre")
            await self.stage.hold(0.5)
            return "Enregistrement commencé : chaque commande est filmée jusqu'à « Arrête l'enregistrement »."
        elif i == "record_stop":
            if not (self.live_recorder and self.live_recorder.active):
                return "Aucun enregistrement en cours."
            await self.stage.hold(0.8)
            self.live_recorder.end()
            self.live_recorder.trim_dead_time()
            out = self.live_recorder.run_dir / "enregistrement.mp4"
            self.live_recorder.export(out, self.browser.format.output, self.config.crf)
            self.memory.last_video = str(out)
            return f"Vidéo enregistrée : {out}"
        elif i == "world":
            rep = await a.go_world()
        elif i == "go":
            rep = await self.go(args["target"])
        elif i == "zoom_place":
            rep = await self.go(args["target"], prefer_place=True)
        elif i == "zoom_in":
            rep = await self.executor._zoom(args["factor"])
        elif i == "zoom_out":
            rep = await self.executor._zoom(1 / args["factor"])
        elif i == "pan":
            move = await a.map.pan(args["direction"])
            rep = ActionReport(f"pan_{args['direction']}", move.ok, move.note)
        elif i == "search":
            rep = await a.search_saint(args["query"])
        elif i == "open_profile":
            rep = await a.open_profile()
            if rep.ok:
                rep2 = await a.show_profile()
                rep.data["profile"] = rep2.data.get("profile")
        elif i == "close_profile":
            rep = await a.close_profile()
        elif i == "century":
            if not args.get("century"):
                return "Je n'ai pas compris le siècle (ex. « XIIe siècle »)."
            rep = await a.filter_by_century(args["century"])
        elif i == "calendar":
            rep = await a.select_feast_day(args["day"]) if args.get("day") else await a.open_calendar()
        elif i == "apparitions_on":
            rep = await self.apparitions.enable_apparitions_mode()
        elif i == "apparitions_off":
            rep = await self.apparitions.disable_apparitions_mode()
        elif i == "miracles_on":
            rep = await a.set_corpus("miracles")
        else:
            return f"Commande non comprise : « {text} ». Tapez « aide »."
        return self.format_report(rep)

    async def go(self, target: str, prefer_place: bool = False) -> ActionReport:
        """« Va en France », « Zoome sur Paris », « Va en Europe » : à chacun son niveau."""
        a = self.adapter
        cid = a.continent_id(target)
        if cid and not prefer_place:
            return await a.go_continent(cid)
        iso = a.site.find_country(target)
        if iso and not (prefer_place and await a.locate_place(target)):
            return await a.go_to_country(iso)
        return await a.go_to_place(target)

    async def _reopen_after_director(self) -> None:
        self._opened = True  # le directeur laisse la page ouverte sur la fin du scénario
        self.stage.recorder = None

    @staticmethod
    def format_report(rep: ActionReport) -> str:
        out = str(rep)
        profile = rep.data.get("profile") if rep.data else None
        if profile:
            out += "\n" + format_profile(profile)
        results = rep.data.get("results") if rep.data else None
        if results:
            out += "\n" + "\n".join(f"  · {r['name']} — {r['meta']} ({r['dates']})" for r in results[:8])
        if rep.data and rep.data.get("approximate"):
            out += "\n  (lieu approximatif selon SanctiMaps)"
        return out


def format_profile(p: dict) -> str:
    """La fiche telle que le site l'affiche — rien d'ajouté, rien d'inventé."""
    lines = [f"  Fiche : {p.get('title')}"]
    if p.get("aka"):
        lines.append(f"  Aussi : {p['aka']}")
    for key, value in p.get("rows", []):
        if value:
            lines.append(f"  {key.capitalize()} : {value}")
    if p.get("approximate_dates"):
        lines.append("  (dates approximatives selon le site)")
    bio = p.get("biography") or p.get("description")
    if bio:
        lines.append(f"  {bio[:300]}{'…' if len(bio) > 300 else ''}")
    if p.get("sources"):
        lines.append("  Sources : " + ", ".join(s["label"] for s in p["sources"]))
    return "\n".join(lines)
