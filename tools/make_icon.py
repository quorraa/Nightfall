"""Draw web/icon-180.png (crescent on a night gradient) with no image library."""

import math
import struct
import zlib
from pathlib import Path

SIZE, SS = 180, 4  # 4x4 supersampling


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


def main():
    rows = bytearray()
    for py in range(SIZE):
        rows.append(0)
        for px in range(SIZE):
            acc = [0.0, 0.0, 0.0]
            for j in range(SS):
                for i in range(SS):
                    c = shade((px + (i + 0.5) / SS) / SIZE, (py + (j + 0.5) / SS) / SIZE)
                    acc = [a + v for a, v in zip(acc, c)]
            rows.extend(int(max(0, min(1, a / SS / SS)) ** (1 / 1.0) * 255 + 0.5) for a in acc)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    out = Path(__file__).resolve().parent.parent / "web" / "icon-180.png"
    out.write_bytes(png)
    print(out)


if __name__ == "__main__":
    main()
