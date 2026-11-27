"""Record the README media: a portrait and a landscape GIF of the lights-out sequence, and stills.

Needs a dry-run server (so the slider doesn't touch your screens), Playwright for Python and ffmpeg:

    .\\nightfall.exe --port 39848 --dry-run
    uv run --no-project --with playwright python tools/capture.py --out docs/media --frames <temp dir>
    uv run --no-project --with playwright python tools/capture.py --scenes    # just the scene stills

The page runs with ?capture, so the scene advances exactly one step per saved frame and the GIF
plays smoothly however slowly the browser renders.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

SHOWN_HOST = "Living room PC"  # replaces the real PC name in the recordings


def fake_host(route):
    resp = route.fetch()
    try:
        data = resp.json()
        data["host"] = SHOWN_HOST
        data["dry_run"] = False  # show the wording a real install shows, not "Test mode"
        route.fulfill(response=resp, body=json.dumps(data), content_type="application/json")
    except Exception:
        route.fulfill(response=resp)


def open_page(browser, url, w, h, dsf, mobile):
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=dsf,
                              is_mobile=mobile, has_touch=mobile, reduced_motion="no-preference")
    page = ctx.new_page()
    page.route("**/api/**", fake_host)
    page.goto(url)
    page.wait_for_function("window.nightfall && document.querySelector('#hostName').textContent.includes('PC')")
    page.wait_for_timeout(300)
    return ctx, page


def record(browser, base, name, w, h, dsf, mobile, frames_dir: Path, still_dir: Path):
    """Idle, slide to turn off, lights out, then a time-lapse of the night sky coming out."""
    ctx, page = open_page(browser, f"{base}/?capture&seed=7", w, h, dsf, mobile)
    print(name, page.evaluate("(() => { const g = nightfall.renderer.getContext(); "
                              "const e = g.getExtension('WEBGL_debug_renderer_info'); "
                              "return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()"))
    out = frames_dir / name
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    n = 0

    def shot(dt):
        nonlocal n
        page.evaluate(f"nightfall.step({dt})")
        page.screenshot(path=str(out / f"{n:04d}.png"))
        n += 1

    for _ in range(14):  # idle, lamp lit
        shot(1 / 15)
    page.screenshot(path=str(still_dir / f"{name}-idle.jpg"), type="jpeg", quality=90)

    box = page.locator("#knob").bounding_box()
    track = page.locator("#slider").bounding_box()
    x0, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    x1 = track["x"] + track["width"] - box["width"] / 2 - 6
    page.mouse.move(x0, y)
    page.mouse.down()
    steps = 18
    for i in range(1, steps + 1):
        t = i / steps
        ease = t * t * (3 - 2 * t)
        page.mouse.move(x0 + (x1 - x0) * ease, y)
        shot(1 / 15)
    page.mouse.up()

    # Lights out: real time first (lamp fades, "Goodnight." comes in), then speed up.
    total = 92
    for i in range(total):
        k = i / (total - 1)
        shot(1 / 15 + (0.42 - 1 / 15) * max(0.0, (k - 0.25) / 0.75) ** 1.5)
    page.screenshot(path=str(still_dir / f"{name}-night.jpg"), type="jpeg", quality=90)
    ctx.close()
    return out


def still(browser, base, name, w, h, dsf, still_dir: Path):
    """A desktop-sized still of the idle scene and of the night."""
    ctx, page = open_page(browser, f"{base}/?capture&seed=7", w, h, dsf, False)
    for _ in range(10):
        page.evaluate("nightfall.step(1/15)")
    page.screenshot(path=str(still_dir / f"{name}-idle.jpg"), type="jpeg", quality=90)
    ctx.close()
    ctx, page = open_page(browser, f"{base}/?capture&seed=7&night=1", w, h, dsf, False)
    page.evaluate("document.body.dataset.mode = 'night'")
    page.wait_for_timeout(4500)  # the night view fades in over a few seconds
    for _ in range(10):
        page.evaluate("nightfall.step(1/15)")
    page.screenshot(path=str(still_dir / f"{name}-night.jpg"), type="jpeg", quality=90)
    ctx.close()


SCENES = ("lake", "coast", "dunes")


def scene_stills(browser, base, still_dir: Path):
    """A phone-sized still of each scene with its light on: scene-<name>.jpg."""
    for scene in SCENES:
        ctx, page = open_page(browser, f"{base}/?capture&seed=7&scene={scene}", 440, 956, 2, True)
        for _ in range(14):
            page.evaluate("nightfall.step(1/15)")
        page.screenshot(path=str(still_dir / f"scene-{scene}.jpg"), type="jpeg", quality=88)
        ctx.close()
        print(scene, "done")


def to_gif(frames: Path, gif: Path, width: int, fps: int = 12):
    # Frames are 1/15 s of scene time apart; dropping to 12 fps keeps the GIF under ~6 MB.
    # Ordered dither and per-rectangle updates compress far better than error diffusion here.
    vf = (f"fps={fps},scale={width}:-2:flags=lanczos,split[a][b];"
          "[a]palettegen=max_colors=192:stats_mode=diff[p];"
          "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "15", "-i", str(frames / "%04d.png"),
                    "-vf", vf, "-loop", "0", str(gif)], check=True)
    print(gif, f"{gif.stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:39848")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "docs" / "media")
    ap.add_argument("--frames", type=Path, help="scratch folder for PNG frames")
    ap.add_argument("--scenes", action="store_true", help="only the stills of each scene")
    a = ap.parse_args()
    if not a.scenes and not a.frames:
        ap.error("--frames is needed to record the GIFs")
    a.out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu"])
        if a.scenes:
            scene_stills(browser, a.base, a.out)
            browser.close()
            return
        portrait = record(browser, a.base, "portrait", 440, 956, 2, True, a.frames, a.out)
        landscape = record(browser, a.base, "landscape", 956, 440, 2, True, a.frames, a.out)
        still(browser, a.base, "desktop", 1440, 900, 1, a.out)
        browser.close()
    to_gif(portrait, a.out / "portrait.gif", 300)
    to_gif(landscape, a.out / "landscape.gif", 640)


if __name__ == "__main__":
    main()
