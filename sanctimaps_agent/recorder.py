"""Enregistrement image par image et export FFmpeg.

Les images sont écrites sur disque, rangées par séquence (un plan du
scénario = une séquence). C'est ce qui permet de refaire une seule séquence :
ses images sont remplacées, les autres restent.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)


def ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:  # pragma: no cover - dépend de l'installation
        raise RuntimeError("FFmpeg introuvable : installez ffmpeg ou `pip install imageio-ffmpeg`.") from exc


@dataclass
class FrameInfo:
    index: int
    tag: str  # action | hold | wait | transition
    state: str
    path: str


@dataclass
class Segment:
    shot_id: str
    label: str
    frames: list[FrameInfo] = field(default_factory=list)
    planned_s: float = 0.0
    notes: list[str] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        return len(self.frames)


class FrameRecorder:
    def __init__(self, run_dir: Path, fps: int = 30):
        self.run_dir = Path(run_dir)
        self.fps = fps
        self.segments: dict[str, Segment] = {}
        self.order: list[str] = []
        self.current: Segment | None = None
        self.active = False
        self._last_hash: int | None = None

    # ------------------------------------------------------------ séquences

    def begin(self, shot_id: str, label: str, planned_s: float = 0.0) -> Segment:
        seg_dir = self.run_dir / "frames" / shot_id
        if seg_dir.exists():
            shutil.rmtree(seg_dir)
        seg_dir.mkdir(parents=True, exist_ok=True)
        seg = Segment(shot_id, label, planned_s=planned_s)
        self.segments[shot_id] = seg
        if shot_id not in self.order:
            self.order.append(shot_id)
        self.current = seg
        self.active = True
        return seg

    def end(self) -> Segment | None:
        seg, self.current, self.active = self.current, None, False
        return seg

    def add(self, jpeg: bytes, tag: str, state: str) -> None:
        if not self.active or self.current is None:
            return
        seg = self.current
        path = self.run_dir / "frames" / seg.shot_id / f"{len(seg.frames):06d}.jpg"
        path.write_bytes(jpeg)
        seg.frames.append(FrameInfo(len(seg.frames), tag, state, str(path)))

    def frame_count(self) -> int:
        return sum(len(self.segments[s].frames) for s in self.order)

    # ------------------------------------------------------ temps morts

    def trim_dead_time(self, keep_frames: int = 4) -> int:
        """Retire les images d'attente identiques au-delà de ``keep_frames``.

        Seules les images marquées « wait » sont candidates : une pause voulue
        (« hold ») fait partie de la mise en scène et reste.
        """
        removed = 0
        for shot_id in self.order:
            seg = self.segments[shot_id]
            kept: list[FrameInfo] = []
            run = 0
            prev: bytes | None = None
            for info in seg.frames:
                data = Path(info.path).read_bytes()
                same = prev is not None and data == prev
                prev = data
                if info.tag == "wait" and same:
                    run += 1
                    if run > keep_frames:
                        removed += 1
                        continue
                else:
                    run = 0
                kept.append(info)
            seg.frames = kept
        return removed

    # ------------------------------------------------------------ export

    def all_frames(self) -> list[FrameInfo]:
        return [f for s in self.order for f in self.segments[s].frames]

    def export(self, out_path: Path, output_size: tuple[int, int], crf: int = 18) -> Path:
        frames = self.all_frames()
        if not frames:
            raise RuntimeError("Aucune image enregistrée.")
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        w, h = output_size
        cmd = [
            ffmpeg_exe(), "-y", "-loglevel", "error",
            "-f", "image2pipe", "-framerate", str(self.fps), "-c:v", "mjpeg", "-i", "-",
            "-vf", f"scale={w}:{h}:flags=lanczos,format=yuv420p",
            "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
            "-profile:v", "high", "-r", str(self.fps), "-movflags", "+faststart",
            str(out_path),
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            for info in frames:
                proc.stdin.write(Path(info.path).read_bytes())
        finally:
            proc.stdin.close()
            code = proc.wait()
        if code != 0:
            raise RuntimeError(f"FFmpeg a échoué (code {code}).")
        self.write_manifest(out_path.with_suffix(".json"))
        return out_path

    def write_manifest(self, path: Path) -> None:
        data = {
            "fps": self.fps,
            "segments": [
                {
                    "shot_id": s,
                    "label": self.segments[s].label,
                    "frames": len(self.segments[s].frames),
                    "seconds": round(len(self.segments[s].frames) / self.fps, 2),
                    "planned_s": self.segments[s].planned_s,
                    "notes": self.segments[s].notes,
                }
                for s in self.order
            ],
        }
        Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2))
