"""Draw the app icon (crescent on a night gradient) with no image library.

    web/icon-180.png        the phone's home-screen icon: a full square (iOS rounds it)
    assets/icon-<N>.png     the Windows icon at each size it is shown at, with rounded
                            corners; build.rs puts these into nightfall.exe
"""

import math
import struct
import zlib
from pathlib import Path

SS = 4  # 4x4 supersampling
ROOT = Path(__file__).resolve().parent.parent
WINDOWS_SIZES = (16, 20, 24, 32, 40, 48, 64, 256)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


STARS = [(0.22, 0.24, 1.0), (0.34, 0.62, 0.7), (0.16, 0.48, 0.5), (0.48, 0.18, 0.55), (0.78, 0.80, 0.45), (0.28, 0.84, 0.6)]


def shade(x, y):
    top, bottom = (0.02, 0.026, 0.085), (0.13, 0.11, 0.26)
    col = mix(top, bottom, smooth(0.0, 1.0, y))
    for sx, sy, b in STARS:
        d = math.hypot(x - sx, y - sy)
        col = mix(col, (0.9, 0.92, 1.0), b * math.exp(-(d * d) / 0.00006))
    mx, my, r = 0.6, 0.46, 0.24
    d = math.hypot(x - mx, y - my)
    col = mix(col, (0.5, 0.52, 0.72), 0.35 * math.exp(-d * 6) * (1 if d > r else 0))
    disc = smooth(r + 0.004, r - 0.004, d)
    shadow = smooth(r + 0.01, r - 0.01, math.hypot(x - mx + 0.12, y - my + 0.07))
    col = mix(col, (0.93, 0.9, 0.83), disc * (1 - shadow))
    return col


def inside_rounded(x, y, inset, radius):
    """Is (x, y) inside a rounded square inset from the unit square's edges?"""
    lo, hi = inset + radius, 1 - inset - radius
    dx = max(lo - x, 0, x - hi)
    dy = max(lo - y, 0, y - hi)
    return math.hypot(dx, dy) <= radius


def render(size, rounded):
    # Small icons keep the shape nearly full size so the crescent stays readable.
    inset = 0.0 if size <= 24 else 0.03
    radius = 0.2
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            acc, cover = [0.0, 0.0, 0.0], 0
            for j in range(SS):
                for i in range(SS):
                    x, y = (px + (i + 0.5) / SS) / size, (py + (j + 0.5) / SS) / size
                    if rounded and not inside_rounded(x, y, inset, radius):
                        continue
                    # Shade in the shape's own coordinates so the art fills it.
                    u = (x - inset) / (1 - 2 * inset) if rounded else x
                    v = (y - inset) / (1 - 2 * inset) if rounded else y
                    acc = [a + c for a, c in zip(acc, shade(u, v))]
                    cover += 1
            rgb = [int(max(0, min(1, a / cover)) * 255 + 0.5) if cover else 0 for a in acc]
            rows.extend(rgb)
            if rounded:
                rows.append(int(cover / SS / SS * 255 + 0.5))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    color_type = 6 if rounded else 2  # RGBA or RGB
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, color_type, 0, 0, 0))
    return png + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


def main():
    out = ROOT / "web" / "icon-180.png"
    out.write_bytes(render(180, rounded=False))
    print(out)
    (ROOT / "assets").mkdir(exist_ok=True)
    for size in WINDOWS_SIZES:
        out = ROOT / "assets" / f"icon-{size}.png"
        out.write_bytes(render(size, rounded=True))
        print(out)


if __name__ == "__main__":
    main()
