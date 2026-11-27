"""Make src/qr_codes.rs: the QR codes for getting Tailscale on a phone.

    uv run --no-project --with segno --with opencv-python-headless python tools/qr.py --check

--check also draws each code with its quiet zone and reads it back with OpenCV's detector.
"""
from __future__ import annotations

import sys
from pathlib import Path

import segno

CODES = {
    "APP_STORE": "https://apps.apple.com/app/tailscale/id1470499037",
    "GOOGLE_PLAY": "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
}
OUT = Path(__file__).resolve().parent.parent / "src" / "qr_codes.rs"


def rows(url: str) -> list[str]:
    qr = segno.make(url, error="m", micro=False, boost_error=True)
    return ["".join("#" if m else "." for m in row) for row in qr.matrix]


def check(name: str, url: str, code: list[str]) -> None:
    import cv2
    import numpy as np

    n, quiet, px = len(code), 4, 8
    img = np.full(((n + 2 * quiet) * px,) * 2, 255, np.uint8)
    for y, row in enumerate(code):
        for x, c in enumerate(row):
            if c == "#":
                img[(y + quiet) * px:(y + quiet + 1) * px, (x + quiet) * px:(x + quiet + 1) * px] = 0
    got, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    assert got == url, f"{name}: read {got!r}"
    print(f"{name}: {n}x{n}, reads back {got}")


def main() -> None:
    codes = {name: rows(url) for name, url in CODES.items()}
    lines = ["// Made by tools/qr.py; run it again rather than editing this by hand."]
    for name, code in codes.items():
        lines.append(f"// {CODES[name]}")
        lines.append(f"pub const {name}: &[&str] = &[")
        lines += [f'    "{row}",' for row in code]
        lines.append("];")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote", OUT)
    if "--check" in sys.argv:
        for name, code in codes.items():
            check(name, CODES[name], code)


if __name__ == "__main__":
    main()
