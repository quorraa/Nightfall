"""Screenshot the page at given sizes with headless Chromium on the GPU, for checking scenes.

    uv run --no-project --with playwright python tools/shot.py --query "scene=lake" --out <folder>
        [--sizes 440x956,956x440,1440x900] [--night SECONDS] [--steps N] [--debug nopost]

Needs a dry-run server on port 39848 (see the README). The page runs with ?capture, so the scene
advances exactly --steps frames of 1/15 s before each picture; --night N turns the lights out and
advances N more seconds of scene time (the night sky needs about 30 s to come out fully).
Writes <out>/<width>x<height>[-night].png and prints the WebGL renderer and any console errors.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:39848")
    ap.add_argument("--query", default="")
    ap.add_argument("--sizes", default="440x956,956x440,1440x900")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--night", type=float, default=0.0)
    ap.add_argument("--debug", default="")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    q = "capture&seed=7" + (f"&{a.query}" if a.query else "") + (f"&debug={a.debug}" if a.debug else "")
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu"])
        for size in a.sizes.split(","):
            w, h = (int(v) for v in size.lower().split("x"))
            mobile = min(w, h) < 600
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1,
                                      is_mobile=mobile, has_touch=mobile)
            page = ctx.new_page()
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{a.base}/?{q}")
            try:
                page.wait_for_function("window.nightfall && window.nightfall.step", timeout=20000)
            except Exception:
                print(size, "page did not start:", errors)
                ctx.close()
                continue
            for _ in range(a.steps):
                page.evaluate("nightfall.step(1/15)")
            name = f"{w}x{h}"
            if a.night > 0:
                page.evaluate("nightfall.setLamp(0); nightfall.setNight(true); document.body.dataset.mode = 'night'")
                page.wait_for_timeout(4300)  # the "Goodnight." view fades in
                n = max(1, round(a.night * 4))
                for _ in range(n):
                    page.evaluate(f"nightfall.step({a.night / n})")
                name += "-night"
            page.screenshot(path=str(a.out / f"{name}.png"))
            print(size, page.evaluate("(() => { const g = nightfall.renderer.getContext(); "
                                      "const e = g.getExtension('WEBGL_debug_renderer_info'); "
                                      "return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })()"),
                  "errors:", errors or "none")
            ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
