"""La projection de SanctiMaps (src/js/map/projection.js), portée en Python.

La carte est un Mercator dans un carré de WORLD_SIZE unités ; la scène SVG
applique ``translate(x y) scale(k)``. Un point projeté (px, py) est donc à
l'écran en (x + px·k, y + py·k), relativement à la zone de carte.
"""

from __future__ import annotations

import math

WORLD_SIZE = 1_000_000
MAX_LAT = 84.0


def project(lon: float, lat: float) -> tuple[float, float]:
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    x = (lon + 180) / 360 * WORLD_SIZE
    phi = math.radians(lat)
    y = (0.5 - math.log(math.tan(math.pi / 4 + phi / 2)) / (2 * math.pi)) * WORLD_SIZE
    return x, y


def unproject(x: float, y: float) -> tuple[float, float]:
    lon = x / WORLD_SIZE * 360 - 180
    t = math.pi * (1 - 2 * (y / WORLD_SIZE))
    lat = math.degrees(2 * math.atan(math.exp(t)) - math.pi / 2)
    return lon, lat


def to_screen(point: tuple[float, float], transform: tuple[float, float, float]) -> tuple[float, float]:
    k, tx, ty = transform
    return tx + point[0] * k, ty + point[1] * k
