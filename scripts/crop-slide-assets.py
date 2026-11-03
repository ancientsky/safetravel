"""Rebuild the poster artwork in web/slides/assets/ from the Taiwan CDC originals (slide.html, docs/SLIDES.md).

Originals (supplied by the repository owner, Taiwan CDC public-health posters) live in scripts/slide-sources/:
  healthy-travel-symptoms.jpg  「台灣美 健康玩」 poster (2657x3780): 7 symptom badges + the two big mascots
  dont-bring-germs.png         「小心別把病菌帶回國」 poster (1608x2307): the fly and the rat in holiday clothes
  cdc-logo.png                 Taiwan CDC seal (1920x1920, RGBA)

Only artwork is cut out (never the poster text: slide text is live HTML). Backgrounds are removed with a flood fill
from the crop border over "background-coloured" pixels; whatever the fill cannot reach (the figure, plus holes inside
its outline) becomes opaque, with a light feather on the edge.

Needs Pillow + numpy (no scipy). In the dev container use the system interpreter, which has both:
    /usr/bin/python3 scripts/crop-slide-assets.py
Output is deterministic for a given Pillow version; re-run after replacing a source file.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts" / "slide-sources"
OUT = ROOT / "web" / "slides" / "assets"

# symptom badge -> (crop box in the 2657x3780 original, keep neutral greys/whites outside the red ring)
SYMPTOMS = {
    "vomiting": ((70, 1630, 515, 2050), False),
    "aches": ((560, 1560, 990, 2032), False),
    "lymph": ((1070, 1570, 1500, 2003), False),
    "respiratory": ((100, 2300, 540, 2740), True),
    "fever": ((610, 2130, 1040, 2722), True),
    "rash": ((130, 2975, 540, 3420), True),
    "diarrhea": ((600, 2930, 1010, 3402), True),
}


def flood(mask: np.ndarray, seeds) -> np.ndarray:
    """Pixels of `mask` 4-connected to any seed (PIL flood fill; the image must be a writable copy)."""
    m = Image.fromarray((mask * 255).astype("uint8")).copy()
    for s in seeds:
        if m.getpixel(s) == 255:
            ImageDraw.floodfill(m, s, 100, thresh=0)
    return np.asarray(m) == 100


def border(w: int, h: int, step: int = 1):
    return ([(x, 0) for x in range(0, w, step)] + [(x, h - 1) for x in range(0, w, step)]
            + [(0, y) for y in range(0, h, step)] + [(w - 1, y) for y in range(0, h, step)])


def mascot_colours(a: np.ndarray, neutral_ok: bool) -> np.ndarray:
    """Foreground classes of the cartoon art: yellow/orange skin, red, black outline, optionally white/grey."""
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(2), a.min(2)
    fg = ((R > 150) & (R - B > 90)) | ((R > 140) & (G < 90) & (B < 100)) | ((mx < 70) & (B - R < 25))
    if neutral_ok:
        fg |= (mx - mn < 16) & (mn > 90)
    return fg


def ring_circle(a: np.ndarray, lower_only: bool = False):
    """Least-squares circle through the red ring pixels -> (cx, cy, outer radius)."""
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    red = (R > 170) & (G < 70) & (B < 80)
    if lower_only:  # fever: flames above the head are red too
        red[: a.shape[0] // 2] = False
    ys, xs = np.nonzero(red)
    for _ in range(3):
        A = np.c_[2 * xs, 2 * ys, np.ones(len(xs))]
        cx, cy, c = np.linalg.lstsq(A, xs ** 2 + ys ** 2, rcond=None)[0]
        r = np.sqrt(c + cx * cx + cy * cy)
        keep = np.abs(np.hypot(xs - cx, ys - cy) - r) < 0.12 * r
        xs, ys = xs[keep], ys[keep]
    return cx, cy, float(np.percentile(np.hypot(xs - cx, ys - cy), 99.5))


def finish(img: Image.Image, opaque: np.ndarray) -> Image.Image:
    alpha = Image.fromarray((opaque * 255).astype("uint8")).filter(ImageFilter.MedianFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    img = img.copy()
    img.putalpha(alpha)
    return img.crop(img.getbbox())


def fit(img: Image.Image, max_side: int) -> Image.Image:
    s = max_side / max(img.size)
    return img if s >= 1 else img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)


def save(img: Image.Image, name: str, quality: int = 86) -> None:
    p = OUT / name
    img.save(p, "WEBP", quality=quality, method=6, alpha_quality=90)
    print(f"{p.relative_to(ROOT)}  {img.width}x{img.height}  {p.stat().st_size // 1024} KB")


def symptoms(src: Image.Image) -> None:
    for name, (box, neutral_ok) in SYMPTOMS.items():
        c = src.crop(box)
        a = np.asarray(c).astype(int)
        h, w = a.shape[:2]
        cx, cy, ro = ring_circle(a, lower_only=name == "fever")
        yy, xx = np.mgrid[0:h, 0:w]
        inside = np.hypot(xx - cx, yy - cy) <= ro + 1
        reach = flood(mascot_colours(a, neutral_ok) | inside, [(int(cx), int(cy))])
        outside = flood(~reach, border(w, h))
        save(fit(finish(c, ~outside), 400), f"sym-{name}.webp")


def mascots(src: Image.Image) -> None:
    box = (1050, 1430, 2657, 3330)  # bottom edge stops above the poster footer
    c = src.crop(box)
    a = np.asarray(c).astype(int)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    X, Y = xx + box[0], yy + box[1]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    warm = ((R > 150) & (R - B > 90)) | ((R > 140) & (G < 90) & (B < 100))
    fg = mascot_colours(a, False)
    fg &= ~((X < 1530) & (Y < 2160))                # the "swollen lymph nodes" badge and its label
    fg &= ~((X > 2250) & (Y > 3060) & ~warm)        # dark trees under the raised foot
    seeds = [(2079 - box[0], 2835 - box[1]), (1323 - box[0], 2551 - box[1])]  # big mascot belly, small mascot face
    reach = flood(fg, seeds)
    outside = flood(~reach, [p for p in border(w, h) if p[1] < h - 1])  # bottom row is a straight cut
    save(fit(finish(c, ~outside), 1100), "mascots.webp")


def pests(src: Image.Image) -> None:
    """Fly + rat (one layer: they overlap) on a near-white photo background; floor shadows kept as translucent black."""
    box = (610, 1250, 1590, 1925)
    c = src.crop(box)
    a = np.asarray(c).astype(int)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    mx, mn, L = a.max(2), a.min(2), a.mean(2)
    bg = flood((mn > 226) & (mx - mn < 14), border(w, h, 3))
    shadow = (mx - mn < 20) & (mn > 150) & ~bg
    bg2 = flood(bg | shadow, border(w, h, 3))
    bg2 |= (xx + box[0] < 790) & (yy + box[1] > 1440)  # the woman's suitcase on the left edge
    alpha = np.where(bg2, np.clip((234 - L) * 2.6, 0, 150), 255)  # near-white -> fully transparent
    alpha[(xx + box[0] < 790) & (yy + box[1] > 1440)] = 0
    rgb = np.where(bg2[..., None], 30, a).astype("uint8")
    img = Image.fromarray(rgb)
    img.putalpha(Image.fromarray(alpha.astype("uint8")).filter(ImageFilter.MedianFilter(3)))
    save(img.crop(img.getbbox()), "pests.webp", 84)


def logo(src: Image.Image) -> None:
    img = src.convert("RGBA").resize((512, 512), Image.LANCZOS)
    p = OUT / "cdc-logo.png"
    img.save(p, optimize=True)
    print(f"{p.relative_to(ROOT)}  512x512  {p.stat().st_size // 1024} KB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    poster = Image.open(SRC / "healthy-travel-symptoms.jpg").convert("RGB")
    symptoms(poster)
    mascots(poster)
    pests(Image.open(SRC / "dont-bring-germs.png").convert("RGB"))
    logo(Image.open(SRC / "cdc-logo.png"))


if __name__ == "__main__":
    main()
