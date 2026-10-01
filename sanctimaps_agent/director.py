"""DIRECTOR MODE : l'utilisateur décrit le résultat, l'agent fait le reste.

1. construire le scénario ;
2. répéter hors caméra : chaque plan est exécuté et vérifié, les choix
   ouverts (quel saint, quelles zones) sont fixés ;
3. tourner : page neuve, chaque plan est filmé image par image ;
4. supprimer les temps morts ;
5. contrôler la qualité, refaire uniquement les séquences fautives ;
6. exporter en MP4 (H.264).
"""

from __future__ import annotations

import copy
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .adapter.sanctimaps import ActionReport
from .config import STYLES, MotionStyle, resolve_format
from .quality import QualityChecker, QualityReport
from .recorder import FrameRecorder
from .scenario import Scenario, Shot

if TYPE_CHECKING:
    from .agent import SanctiMapsVideoAgent

log = logging.getLogger(__name__)


def style_from_name(name: str) -> MotionStyle:
    """« documentary@1.40 » → style documentaire accéléré ×1,4 ; « cinematic-slow » → ralenti."""
    base, _, factor = name.partition("@")
    slow = base.endswith("-slow")
    base = base.removesuffix("-slow")
    style = STYLES.get(base, STYLES["documentary"])
    if slow:
        style = style.slower()
    if factor:
        style = style.faster(float(factor))
    return style


@dataclass
class DirectorResult:
    scenario: Scenario
    video: Path | None
    reports: dict[str, ActionReport] = field(default_factory=dict)
    quality: QualityReport | None = None
    reshoots: list[str] = field(default_factory=list)
    trimmed_frames: int = 0
    elapsed_s: float = 0.0

    def summary(self) -> str:
        lines = [self.scenario.timeline(), ""]
        for sid, rep in self.reports.items():
            lines.append(f"  {sid} {rep}")
        if self.trimmed_frames:
            lines.append(f"Temps morts supprimés : {self.trimmed_frames} image(s).")
        if self.reshoots:
            lines.append(f"Séquences refaites : {', '.join(self.reshoots)}")
        if self.quality:
            lines.append(self.quality.summary())
        if self.video:
            lines.append(f"Vidéo : {self.video} ({self.elapsed_s:.0f} s de calcul)")
        return "\n".join(lines)


class Director:
    def __init__(self, agent: "SanctiMapsVideoAgent"):
        self.agent = agent
        self.recorder: FrameRecorder | None = None
        self.scenario: Scenario | None = None
        self.reports: dict[str, ActionReport] = {}

    # ------------------------------------------------------------- étapes

    async def plan(self, request: str, defaults: dict | None = None) -> Scenario:
        # Le plan s'appuie sur les données publiées par le site : il faut l'ouvrir.
        await self.agent.ensure_open()
        return await self.agent.planner.plan(request, defaults)

    async def _fresh_page(self, scenario: Scenario) -> None:
        fmt = resolve_format(scenario.aspect, scenario.resolution)
        await self.agent.ensure_started(fmt)
        style = style_from_name(scenario.style)
        self.agent.adapter.set_style(style)
        await self.agent.adapter.open()

    async def rehearse(self, scenario: Scenario) -> dict[str, ActionReport]:
        """Répétition hors caméra : tout est exécuté et vérifié, rien n'est filmé."""
        await self._fresh_page(scenario)
        reports = {}
        for shot in scenario.shots:
            rep = await self.agent.executor.run(shot)
            reports[shot.id] = rep
            log.info("répétition %s %s", shot.id, rep)
        return reports

    async def shoot(self, scenario: Scenario, run_dir: Path, only: set[str] | None = None) -> dict[str, ActionReport]:
        """Tournage. Avec ``only``, les autres plans sont rejoués hors caméra
        (pour retrouver le bon état de départ) et leurs images sont conservées."""
        await self._fresh_page(scenario)
        if self.recorder is None or only is None:
            self.recorder = FrameRecorder(run_dir, self.agent.config.fps)
        self.agent.stage.recorder = self.recorder
        reports = {}
        last_wanted = max((i for i, s in enumerate(scenario.shots) if only is None or s.id in only), default=-1)
        for i, shot in enumerate(scenario.shots):
            if i > last_wanted:
                break
            film = only is None or shot.id in only
            if film:
                self.recorder.begin(shot.id, shot.label, shot.duration_s)
                self.agent.stage.frames_this_segment = 0
            started = time.monotonic()
            rep = await self.agent.executor.run(shot)
            if film:
                target = round(shot.duration_s * self.agent.config.fps)
                missing = target - self.agent.stage.frames_this_segment
                if missing > 0:
                    await self.agent.stage.hold(missing / self.agent.config.fps)
                self.recorder.end()
            reports[shot.id] = rep
            log.info("plan %s %s (%.1f s de calcul)", shot.id, rep, time.monotonic() - started)
        return reports

    async def make(self, request: str | Scenario, out: Path | None = None, defaults: dict | None = None,
                   confirm=None, max_reshoots: int = 2) -> DirectorResult:
        t0 = time.monotonic()
        scenario = request if isinstance(request, Scenario) else await self.plan(request, defaults)
        if confirm and not await confirm(scenario):
            return DirectorResult(scenario, None)
        self.scenario = scenario

        rehearsal = await self.rehearse(scenario)
        failed = [sid for sid, r in rehearsal.items() if not r.ok]
        if failed:
            scenario.notes.append("Plans non vérifiés en répétition (retirés) : " + ", ".join(
                f"{sid} ({rehearsal[sid].detail})" for sid in failed))
            removed = sum(s.duration_s for s in scenario.shots if s.id in failed)
            scenario.shots = [s for s in scenario.shots if s.id not in failed]
            if scenario.shots and removed:
                scenario.shots[-1].duration_s += removed  # garder la durée demandée
        if not scenario.shots:
            return DirectorResult(scenario, None, rehearsal)

        run_dir = Path(self.agent.config.work_dir) / time.strftime("%Y%m%d-%H%M%S")
        self.reports = await self.shoot(scenario, run_dir)
        trimmed = self.recorder.trim_dead_time()

        checker = QualityChecker(self.agent.config.fps)
        shots = {s.id: s for s in scenario.shots}
        quality = checker.check(self.recorder, shots, self.reports)
        reshoots: list[str] = []
        for _ in range(max_reshoots):
            redo = set(quality.shots_to_redo)
            if not redo:
                break
            log.info("Séquences à refaire : %s", sorted(redo))
            new = await self.shoot(scenario, run_dir, only=redo)
            self.reports.update(new)
            trimmed += self.recorder.trim_dead_time()
            reshoots += sorted(redo)
            quality = checker.check(self.recorder, shots, self.reports)

        fmt = resolve_format(scenario.aspect, scenario.resolution)
        out = Path(out) if out else run_dir / f"sanctimaps-{scenario.aspect.replace(':', 'x')}.mp4"
        video = self.recorder.export(out, fmt.output, self.agent.config.crf)
        (run_dir / "scenario.json").write_text(scenario.to_json())
        (run_dir / "rapport.json").write_text(json.dumps({
            "reports": {k: str(v) for k, v in self.reports.items()},
            "quality": [str(i) for i in quality.issues],
            "reshoots": reshoots,
        }, ensure_ascii=False, indent=2))
        self.agent.memory.last_scenario = scenario
        self.agent.memory.last_video = str(video)
        return DirectorResult(scenario, video, self.reports, quality, reshoots, trimmed, time.monotonic() - t0)

    async def redo_last_sequence(self, out: Path | None = None) -> DirectorResult:
        """« Recommence uniquement la dernière séquence. »"""
        if not (self.scenario and self.recorder):
            raise RuntimeError("Aucune vidéo à reprendre.")
        t0 = time.monotonic()
        last = self.scenario.shots[-1].id
        new = await self.shoot(self.scenario, self.recorder.run_dir, only={last})
        self.reports.update(new)
        self.recorder.trim_dead_time()
        quality = QualityChecker(self.agent.config.fps).check(
            self.recorder, {s.id: s for s in self.scenario.shots}, self.reports)
        fmt = resolve_format(self.scenario.aspect, self.scenario.resolution)
        out = Path(out) if out else self.recorder.run_dir / f"sanctimaps-{self.scenario.aspect.replace(':', 'x')}-v2.mp4"
        video = self.recorder.export(out, fmt.output, self.agent.config.crf)
        self.agent.memory.last_video = str(video)
        return DirectorResult(self.scenario, video, self.reports, quality, [last], 0, time.monotonic() - t0)

    def variant(self, *, aspect: str | None = None, slower: float | None = None,
                smoother: bool = False) -> Scenario:
        """Une variante du dernier scénario (plus lente, verticale, plus fluide)."""
        if not self.scenario:
            raise RuntimeError("Aucune vidéo précédente.")
        sc = copy.deepcopy(self.scenario)
        if aspect:
            sc.aspect = aspect
        if slower:
            base, _, factor = sc.style.partition("@")
            speed = (float(factor) if factor else 1.0) / slower
            sc.style = base if abs(speed - 1) < 1e-3 else f"{base}@{speed:.3f}"
            for shot in sc.shots:
                shot.duration_s = round(shot.duration_s * slower, 2)
        if smoother:
            # Plus fluide : transitions et zooms plus longs, pris sur les pauses ;
            # la durée totale ne bouge que si les pauses n'y suffisent pas.
            old_style = style_from_name(sc.style)
            base = sc.style.split("@")[0].removesuffix("-slow")
            sc.style = "cinematic" if base != "slow" else "slow"
            nat = self.agent.planner.natural_seconds
            total = sum(s.duration_s for s in sc.shots)
            old_nat = [nat(s.action, old_style, i <= 2) for i, s in enumerate(sc.shots)]
            new_nat = [nat(s.action, style_from_name(sc.style), i <= 2) for i, s in enumerate(sc.shots)]
            # Plus doux, mais dans la même durée : si les mouvements cinématiques
            # ne tiennent pas, ils sont accélérés juste assez (comme au premier plan).
            if sum(new_nat) > total * 0.9:
                speed = sum(new_nat) / (total * 0.85)
                sc.style = f"{sc.style}@{speed:.3f}"
                new_nat = [n / speed for n in new_nat]
            slack = [max(0.0, s.duration_s - n) for s, n in zip(sc.shots, old_nat)]
            free = max(0.0, sum(s.duration_s for s in sc.shots) - sum(new_nat))
            total_slack = sum(slack) or 1.0
            for shot, n, sl in zip(sc.shots, new_nat, slack):
                shot.duration_s = round(n + free * sl / total_slack, 2)
            sc.notes.append("Mouvements plus longs et plus doux (style cinématique).")
        return sc
