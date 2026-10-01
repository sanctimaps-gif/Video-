"""Contrôle qualité de la vidéo, séquence par séquence, avant export."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .recorder import FrameRecorder
from .vision import frame_stats


@dataclass
class Issue:
    shot_id: str
    kind: str  # fluidite | lisibilite | brusque | chargement | vide | clic_rate | panneau | duree
    detail: str
    severity: str = "warning"  # warning | error

    def __str__(self) -> str:
        return f"[{self.severity}] {self.shot_id} · {self.kind} : {self.detail}"


@dataclass
class QualityReport:
    issues: list[Issue] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)

    @property
    def shots_to_redo(self) -> list[str]:
        return sorted({i.shot_id for i in self.issues if i.severity == "error"})

    def summary(self) -> str:
        if not self.issues:
            return "Contrôle qualité : aucun problème détecté."
        return "Contrôle qualité :\n" + "\n".join(f"  {i}" for i in self.issues)


class QualityChecker:
    def __init__(self, fps: int = 30, blank_std: float = 2.5, jump_threshold: float = 38.0,
                 freeze_s: float = 1.2, duration_tolerance: float = 0.3):
        self.fps = fps
        self.blank_std = blank_std
        self.jump_threshold = jump_threshold
        self.freeze_s = freeze_s
        self.duration_tolerance = duration_tolerance

    def check(self, recorder: FrameRecorder, shots: dict, reports: dict) -> QualityReport:
        report = QualityReport()
        for shot_id in recorder.order:
            seg = recorder.segments[shot_id]
            shot = shots.get(shot_id)
            rep = reports.get(shot_id)
            issues = self.check_segment(shot_id, seg, shot, rep)
            report.issues += issues
            report.metrics[shot_id] = {"frames": len(seg.frames), "seconds": round(len(seg.frames) / self.fps, 2)}
        return report

    def check_segment(self, shot_id, seg, shot, rep) -> list[Issue]:
        issues: list[Issue] = []
        if rep is not None and not rep.ok:
            issues.append(Issue(shot_id, "clic_rate", f"action non vérifiée : {rep.detail}", "error"))
        if not seg.frames:
            issues.append(Issue(shot_id, "vide", "aucune image", "error"))
            return issues

        # Durée : un plan beaucoup plus long que prévu casse le rythme.
        seconds = len(seg.frames) / self.fps
        if shot is not None and shot.duration_s > 0:
            over = seconds - shot.duration_s
            if over > max(1.0, shot.duration_s * self.duration_tolerance):
                issues.append(Issue(shot_id, "duree", f"{seconds:.1f} s au lieu de {shot.duration_s:.1f} s"))

        # États visibles indésirables.
        bad_states = [f for f in seg.frames if f.state in ("LOADING", "INTRO_OPEN", "ERROR")]
        if bad_states:
            issues.append(Issue(shot_id, "chargement", f"{len(bad_states)} image(s) d'écran de chargement", "error"))
        partial = [f for f in seg.frames if f.state == "SAINT_PANEL_OPEN" and f.tag == "hold"]
        if len(partial) > self.fps * 0.3:
            issues.append(Issue(shot_id, "panneau", "fiche filmée avant d'être complète", "error"))

        # Analyse d'image : vide, sauts, gel.
        stride = 1 if len(seg.frames) <= 600 else 2
        prev = None
        frozen_run = 0
        blank = 0
        jumps = []
        for info in seg.frames[::stride]:
            stats = frame_stats(Path(info.path).read_bytes())
            if stats["std"] < self.blank_std:
                blank += 1
            if prev is not None:
                diff = float(np.abs(stats["array"] - prev).mean())
                moving_tag = info.tag in ("action", "transition")
                if moving_tag and diff > self.jump_threshold:
                    jumps.append((info.index, diff))
                if moving_tag and diff < 0.01:
                    frozen_run += stride
                else:
                    frozen_run = 0
                if frozen_run / self.fps > self.freeze_s:
                    issues.append(Issue(shot_id, "fluidite", f"mouvement figé vers l'image {info.index}"))
                    frozen_run = -10**9  # un seul signalement
            prev = stats["array"]
        if blank > 2:
            issues.append(Issue(shot_id, "vide", f"{blank} image(s) quasi uniformes", "error"))
        if jumps:
            worst = max(jumps, key=lambda j: j[1])
            severity = "error" if len(jumps) > 2 else "warning"
            issues.append(Issue(shot_id, "brusque", f"{len(jumps)} saut(s) d'image (pire : image {worst[0]})", severity))
        return issues
