"""Ligne de commande.

    python -m sanctimaps_agent video "Fais une vidéo de 30 secondes sur les saints en France."
    python -m sanctimaps_agent plan  "…"                 # scénario seul, sans tournage
    python -m sanctimaps_agent do "Va en France." "Zoome sur Paris." "Cherche saint Louis."
    python -m sanctimaps_agent shell                     # conversation
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .agent import SanctiMapsVideoAgent
from .config import AgentConfig


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sanctimaps_agent", description="Agent vidéo SanctiMaps")
    p.add_argument("--url", default=None, help="adresse de SanctiMaps (défaut : https://sanctimaps.fr/)")
    p.add_argument("--style", default="documentary",
                   choices=["cinematic", "documentary", "fast", "slow", "educational"])
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--work-dir", default="runs")
    p.add_argument("--headed", action="store_true", help="afficher le navigateur")
    p.add_argument("--no-ai", action="store_true", help="ni vision ni planification par Claude")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("video", help="mode réalisateur : une demande, une vidéo")
    v.add_argument("request")
    v.add_argument("--out", default=None)
    v.add_argument("--format", dest="aspect", default=None, choices=["16:9", "9:16", "1:1"])
    v.add_argument("--resolution", default=None, choices=["720p", "1080p", "4k"])
    v.add_argument("--yes", action="store_true", help="ne pas demander de valider le scénario")

    pl = sub.add_parser("plan", help="afficher le scénario sans tourner")
    pl.add_argument("request")

    d = sub.add_parser("do", help="exécuter des commandes à la suite")
    d.add_argument("commands", nargs="+")

    r = sub.add_parser("render", help="tourner un scénario exporté par le studio (JSON, ou texte contenant ```json```)")
    r.add_argument("scenario", help="fichier du scénario")
    r.add_argument("--out", required=True)
    r.add_argument("--resolution", default=None, choices=["720p", "1080p", "4k"])

    sub.add_parser("shell", help="mode conversationnel")
    return p


def make_agent(args) -> SanctiMapsVideoAgent:
    config = AgentConfig(fps=args.fps, work_dir=args.work_dir, headless=not args.headed)
    if args.url:
        config.url = args.url
    if args.no_ai:
        config.vision_enabled = False
        config.llm_planner_enabled = False
    return SanctiMapsVideoAgent(config, style=args.style)


async def ask_confirmation(scenario) -> bool:
    print(scenario.timeline())
    answer = await asyncio.to_thread(input, "Tourner ce scénario ? [O/n] ")
    return answer.strip().lower() in ("", "o", "oui", "y", "yes")


async def run(args) -> int:
    agent = make_agent(args)
    try:
        if args.cmd == "plan":
            scenario = await agent.director.plan(args.request, {"style": args.style})
            print(scenario.timeline())
            return 0
        if args.cmd == "video":
            defaults = {"style": args.style}
            if args.aspect:
                defaults["aspect"] = args.aspect
            if args.resolution and args.resolution != "1080p":
                defaults["resolution"] = args.resolution
            scenario = await agent.director.plan(args.request, defaults)
            if args.aspect:
                scenario.aspect = args.aspect
            if args.resolution and args.resolution != "1080p":
                scenario.resolution = args.resolution
            confirm = None if args.yes or not sys.stdin.isatty() else ask_confirmation
            if confirm is None:
                print(scenario.timeline())
            result = await agent.director.make(scenario, out=args.out, confirm=confirm)
            print(result.summary())
            return 0 if result.video else 1
        if args.cmd == "render":
            from pathlib import Path

            from .studio_format import extract_json, from_studio

            scenario = from_studio(extract_json(Path(args.scenario).read_text()))
            if args.resolution and args.resolution != "1080p":
                scenario.resolution = args.resolution
            print(scenario.timeline())
            result = await agent.director.make(scenario, out=args.out)
            print(result.summary())
            return 0 if result.video else 1
        if args.cmd == "do":
            for command in args.commands:
                print(f"> {command}")
                print(await agent.handle(command))
            return 0
        if args.cmd == "shell":
            print("Agent vidéo SanctiMaps — tapez « aide », ou « quitter ».")
            while True:
                try:
                    line = await asyncio.to_thread(input, "sanctimaps> ")
                except EOFError:
                    break
                if line.strip().lower() in ("quitter", "exit", "quit", "q"):
                    break
                if not line.strip():
                    continue
                try:
                    print(await agent.handle(line, confirm=ask_confirmation))
                except Exception as exc:  # noqa: BLE001 - la conversation continue
                    logging.exception("échec")
                    print(f"Échec : {exc}")
            return 0
    finally:
        await agent.close()
    return 1


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(levelname)s %(name)s: %(message)s")
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
