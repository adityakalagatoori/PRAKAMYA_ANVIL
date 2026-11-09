"""
Director: turns raw VS Code recordings into a narrated product film, entirely inside VS Code.

For every output frame it applies an eased camera (zoom/pan) over the real footage and draws motion
graphics on top: spotlights, highlight boxes with callouts, an animated pointer with click ripples,
key-cap overlays and movie-style chapter titles. Narration (neural TTS) drives each segment's length.

  python video/director.py --clips <dir: tour.mp4 taskA.mp4 agent.mp4 taskC.mp4 + timeline_tour.json> --ffmpeg <ffmpeg.exe>
"""
import argparse
import asyncio
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build" / "director"
W, H, FPS = 1920, 1080, 30
PAD_Y = 30  # source frames are 1920x1020, padded to 1080 (offset y by 30)
VOICE = "en-US-AvaNeural"
ACCENT = (255, 122, 26)
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_R = "C:/Windows/Fonts/segoeui.ttf"
FONT_SB = "C:/Windows/Fonts/seguisb.ttf"
FONT_M = "C:/Windows/Fonts/consolab.ttf"
_fonts = {}


def font(path, size):
    k = (path, size)
    if k not in _fonts:
        try:
            _fonts[k] = ImageFont.truetype(path, size)
        except OSError:
            _fonts[k] = ImageFont.truetype(FONT_B, size)
    return _fonts[k]


def ease(x):
    x = max(0.0, min(1.0, x))
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def out_back(x):
    x = max(0.0, min(1.0, x))
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(" ".join(map(str, cmd))[:300], r.stderr[-2000:])
        sys.exit(1)
    return r.stdout


# ------------------------------------------------------------------ geometry helpers


def fit_aspect(x, y, w, h):
    """Expand a rect to 16:9 around its centre, clamp inside the frame."""
    cx, cy = x + w / 2, y + h / 2
    if w / h > W / H:
        h = w * H / W
    else:
        w = h * W / H
    w, h = min(w, W), min(h, H)
    x = min(max(cx - w / 2, 0), W - w)
    y = min(max(cy - h / 2, 0), H - h)
    return x, y, w, h


class Camera:
    """Keyframes: list of (t_out, rect). Rect is in padded-source coords. Eased between keyframes."""

    def __init__(self, keys):
        self.keys = sorted(keys or [(0, (0, 0, W, H))], key=lambda k: k[0])

    def at(self, t):
        ks = self.keys
        if t <= ks[0][0]:
            return fit_aspect(*ks[0][1])
        for (t0, r0), (t1, r1) in zip(ks, ks[1:]):
            if t <= t1:
                u = ease((t - t0) / max(1e-6, t1 - t0))
                a, b = fit_aspect(*r0), fit_aspect(*r1)
                return tuple(a[i] + (b[i] - a[i]) * u for i in range(4))
        return fit_aspect(*ks[-1][1])


def to_out(rect, cam):
    """Map a padded-source rect into output pixels for the current camera."""
    cx, cy, cw, ch = cam
    sx, sy = W / cw, H / ch
    x, y, w, h = rect
    return ((x - cx) * sx, (y - cy) * sy, w * sx, h * sy)


def pt_out(p, cam):
    cx, cy, cw, ch = cam
    return ((p[0] - cx) * W / cw, (p[1] - cy) * H / ch)


# ------------------------------------------------------------------ overlay drawing


def rounded(draw, box, r, **kw):
    draw.rounded_rectangle([box[0], box[1], box[0] + box[2], box[1] + box[3]], radius=r, **kw)


def fade_in_out(t, t0, t1, d=0.35):
    if t < t0 or t > t1:
        return 0.0
    return min(ease((t - t0) / d), ease((t1 - t) / d), 1.0)


def draw_spotlight(img, rect, a):
    if a <= 0:
        return img
    x, y, w, h = rect
    mask = Image.new("L", (W, H), int(150 * a))
    md = ImageDraw.Draw(mask)
    rounded(md, (x - 10, y - 10, w + 20, h + 20), 16, fill=0)
    mask = mask.filter(ImageFilter.GaussianBlur(6))
    dark = Image.new("RGBA", (W, H), (5, 8, 14, 255))
    dark.putalpha(mask)
    img = Image.alpha_composite(img, dark)
    return img


def draw_box(img, rect, a, label=None, side="auto", color=ACCENT):
    if a <= 0:
        return img
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    x, y, w, h = rect
    grow = 6 * (1 - a)
    for i, al in ((10, 40), (5, 90), (0, 255)):
        rounded(d, (x - 6 - i - grow, y - 6 - i - grow, w + 12 + 2 * i + 2 * grow, h + 12 + 2 * i + 2 * grow), 14 + i, outline=color + (int(al * a),), width=3 if i == 0 else 2)
    if label:
        f = font(FONT_SB, 34)
        tw = d.textlength(label, font=f)
        bw, bh = tw + 44, 62
        if side == "auto":
            side = "above" if y > 160 else "below"
        if side == "right" and x + w + 30 + bw > W:
            side = "left"
        if side == "above":
            bx, by = min(max(x, 24), W - bw - 24), y - bh - 24
        elif side == "below":
            bx, by = min(max(x, 24), W - bw - 24), y + h + 24
        elif side == "left":
            bx, by = max(24, x - bw - 30), y + h / 2 - bh / 2
        else:
            bx, by = x + w + 30, y + h / 2 - bh / 2
        by = min(max(by, 20), H - bh - 20)
        off = (1 - out_back(a)) * 18
        rounded(d, (bx, by + off, bw, bh), 16, fill=(18, 24, 38, int(240 * a)), outline=color + (int(255 * a),), width=2)
        d.text((bx + 22, by + off + 9), label, font=f, fill=(240, 244, 252, int(255 * a)))
    return Image.alpha_composite(img, ov)


CURSOR = [(0, 0), (0, 34), (9, 26), (15, 40), (21, 37), (15, 24), (26, 24)]


def draw_cursor(img, p, clicks_age):
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for age in clicks_age:
        if 0 <= age < 0.6:
            r = 10 + age * 90
            al = int(220 * (1 - age / 0.6))
            d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], outline=ACCENT + (al,), width=4)
    s = 1.35
    poly = [(p[0] + x * s, p[1] + y * s) for x, y in CURSOR]
    shadow = [(x + 3, y + 4) for x, y in poly]
    d.polygon(shadow, fill=(0, 0, 0, 110))
    d.polygon(poly, fill=(255, 255, 255, 255), outline=(10, 12, 18, 255))
    return Image.alpha_composite(img, ov)


def draw_keys(img, keys, a):
    if a <= 0:
        return img
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    f = font(FONT_SB, 44)
    widths = [d.textlength(k, font=f) + 48 for k in keys]
    total = sum(widths) + 50 * (len(keys) - 1)
    x = W / 2 - total / 2
    y = H - 170 + (1 - out_back(a)) * 40
    for i, (k, kw) in enumerate(zip(keys, widths)):
        rounded(d, (x, y + 6, kw, 84), 14, fill=(0, 0, 0, int(140 * a)))
        rounded(d, (x, y, kw, 84), 14, fill=(30, 38, 56, int(245 * a)), outline=(120, 132, 160, int(255 * a)), width=2)
        d.text((x + 24, y + 14), k, font=f, fill=(255, 255, 255, int(255 * a)))
        x += kw
        if i < len(keys) - 1:
            d.text((x + 14, y + 14), "+", font=f, fill=ACCENT + (int(255 * a),))
            x += 50
    return Image.alpha_composite(img, ov)


def draw_chapter(img, num, title, sub, t, t0, t1):
    a = fade_in_out(t, t0, t1, 0.5)
    if a <= 0:
        return img
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    slide = (1 - ease((t - t0) / 0.7)) * -80
    x0, y0 = 70 + slide, H - 250
    grad_h = 300
    for i in range(grad_h):
        al = int(170 * a * (i / grad_h) ** 1.4)
        d.line([(0, H - grad_h + i), (W, H - grad_h + i)], fill=(5, 8, 14, al))
    d.rectangle([x0, y0 + 8, x0 + 10, y0 + 150], fill=ACCENT + (int(255 * a),))
    d.text((x0 + 34, y0), num, font=font(FONT_M, 30), fill=ACCENT + (int(255 * a),))
    d.text((x0 + 32, y0 + 36), title, font=font(FONT_B, 76), fill=(255, 255, 255, int(255 * a)))
    if sub:
        d.text((x0 + 36, y0 + 128), sub, font=font(FONT_R, 34), fill=(190, 200, 220, int(255 * a)))
    return Image.alpha_composite(img, ov)


def draw_badge(img, text, a):
    if a <= 0:
        return img
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    f = font(FONT_SB, 26)
    tw = d.textlength(text, font=f)
    rounded(d, (W - tw - 92, 34, tw + 52, 50), 25, fill=(18, 24, 38, int(225 * a)), outline=(90, 100, 125, int(255 * a)), width=1)
    d.text((W - tw - 66, 42), text, font=f, fill=(200, 208, 225, int(255 * a)))
    return Image.alpha_composite(img, ov)


def draw_title_card(img, t, t0, t1, title, sub):
    a = fade_in_out(t, t0, t1, 0.6)
    if a <= 0:
        return img
    ov = Image.new("RGBA", (W, H), (5, 8, 14, int(165 * a)))
    d = ImageDraw.Draw(ov)
    f1, f2 = font(FONT_B, 150), font(FONT_R, 46)
    tw = d.textlength(title, font=f1)
    s = out_back((t - t0) / 0.9)
    y = H / 2 - 150 + (1 - s) * 40
    d.text((W / 2 - tw / 2, y), title, font=f1, fill=(255, 255, 255, int(255 * a)))
    d.rectangle([W / 2 - 90 * s, y + 190, W / 2 + 90 * s, y + 196], fill=ACCENT + (int(255 * a),))
    sw = d.textlength(sub, font=f2)
    d.text((W / 2 - sw / 2, y + 222), sub, font=f2, fill=(205, 214, 232, int(255 * a)))
    return Image.alpha_composite(img, ov)


# ------------------------------------------------------------------ segment rendering


def decode(ffmpeg, clip, src_in, src_out, speed, n_frames):
    """Yield n_frames BGR frames (padded to 1920x1080) for [src_in, src_out] played at `speed`."""
    vf = f"setpts=(PTS-STARTPTS)/{speed:.5f},fps={FPS},scale=1920:-2,pad=1920:1080:0:{PAD_Y}:color=0x0b0f17"
    p = subprocess.Popen([ffmpeg, "-v", "error", "-ss", f"{src_in:.3f}", "-i", str(clip), "-t", f"{src_out - src_in:.3f}", "-vf", vf,
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    size = W * H * 3
    last = None
    for _ in range(n_frames):
        buf = p.stdout.read(size)
        if len(buf) == size:
            last = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        if last is None:
            last = np.full((H, W, 3), (23, 15, 11), np.uint8)
        yield last
    p.stdout.close()
    p.wait()


def render_segment(ffmpeg, seg, clips, out_path, seconds):
    clip = clips / seg["clip"]
    src_in, src_out = seg["src"]
    span = src_out - src_in
    speed = max(span / seconds, 0.05)
    if speed < 1.0:  # slower than real time: play at 1x and hold the last frame
        speed = 1.0
    n = int(round(seconds * FPS))
    to_t = lambda st: (st - src_in) / speed  # source time -> output time
    cam = Camera([(to_t(k[0]) if k[0] >= src_in - 1e-6 else k[0], k[1]) for k in seg.get("camera", [])])
    anns = seg.get("ann", [])
    enc = subprocess.Popen([ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", str(out_path)], stdin=subprocess.PIPE)
    live = seg.get("live", False)
    badge = seg.get("badge") or (f"model time sped up {speed:.1f}x" if live and speed > 1.25 else None)
    for i, frame in enumerate(decode(ffmpeg, clip, src_in, src_out, speed, n)):
        t = i / FPS
        c = cam.at(t)
        x, y, w, h = c
        crop = frame[int(y):int(y + h), int(x):int(x + w)]
        crop = cv2.resize(crop, (W, H), interpolation=cv2.INTER_CUBIC if w < W else cv2.INTER_AREA)
        img = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).convert("RGBA")
        for a in anns:
            t0, t1 = to_t(a["t"][0]), to_t(a["t"][1])
            if a["k"] == "spot":
                img = draw_spotlight(img, to_out(a["r"], c), fade_in_out(t, t0, t1))
        for a in anns:
            t0, t1 = to_t(a["t"][0]), to_t(a["t"][1])
            k = a["k"]
            if k == "box":
                img = draw_box(img, to_out(a["r"], c), fade_in_out(t, t0, t1), a.get("label"), a.get("side", "auto"))
            elif k == "keys":
                img = draw_keys(img, a["keys"], fade_in_out(t, t0, t1))
            elif k == "chapter":
                img = draw_chapter(img, a["num"], a["title"], a.get("sub"), t, t0, t1)
            elif k == "title":
                img = draw_title_card(img, t, t0, t1, a["title"], a["sub"])
            elif k == "cursor":
                path = [(to_t(pt[0]), pt[1]) for pt in a["path"]]
                if path[0][0] <= t <= path[-1][0] + a.get("linger", 0.8):
                    p = path[-1][1]
                    for (ta, pa), (tb, pb) in zip(path, path[1:]):
                        if t <= tb:
                            u = ease((t - ta) / max(1e-6, tb - ta))
                            p = (pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u)
                            break
                    ages = [t - to_t(ct) for ct in a.get("clicks", [])]
                    img = draw_cursor(img, pt_out(p, c), ages)
        if badge:
            img = draw_badge(img, badge, fade_in_out(t, 0.2, seconds - 0.2))
        enc.stdin.write(np.asarray(img.convert("RGB")).tobytes())
    enc.stdin.close()
    enc.wait()
    return speed


# ------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True)
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(ROOT / "out" / "anvil-vscode-film.mp4"))
    args = ap.parse_args()
    sys.path.insert(0, str(ROOT))
    import build  # reuse tts / mux / join helpers
    from edl import make_edl

    clips = Path(args.clips)
    ffprobe = str(Path(args.ffmpeg).with_name("ffprobe.exe"))
    segs = make_edl(json.loads((clips / "timeline.json").read_text())["tour"])
    if args.only:
        segs = [s for s in segs if s["id"] in args.only.split(",")]
    BUILD.mkdir(parents=True, exist_ok=True)
    build.BUILD = BUILD
    print("voice-over…")
    asyncio.run(build.tts([{"id": s["id"], "text": s["text"]} for s in segs], VOICE, "+0%"))
    out_segs, durs = [], []
    for s in segs:
        audio = BUILD / "audio" / f"{s['id']}.mp3"
        seconds = build.duration(ffprobe, audio) + s.get("tail", 0.9)
        vid = BUILD / f"{s['id']}.video.mp4"
        import hashlib
        key = hashlib.sha256((json.dumps(s, sort_keys=True, default=str) + f"{seconds:.3f}" + Path(__file__).read_text(encoding="utf-8") + str((clips / s["clip"]).stat().st_mtime)).encode()).hexdigest()
        keyf = BUILD / f"{s['id']}.key"
        if vid.exists() and keyf.exists() and keyf.read_text() == key:
            print(f"  {s['id']}: cached")
        else:
            sp = render_segment(args.ffmpeg, s, clips, vid, seconds)
            keyf.write_text(key)
            print(f"  {s['id']}: {seconds:.1f}s (speed x{sp:.2f})")
        seg = BUILD / f"{s['id']}.seg.mp4"
        build.mux(args.ffmpeg, vid, audio, seconds, seg)
        out_segs.append(seg)
        durs.append(seconds)
    Path(args.out).parent.mkdir(exist_ok=True)
    total = build.join(args.ffmpeg, out_segs, durs, Path(args.out))
    print(f"done: {args.out} ({total:.1f}s)")


if __name__ == "__main__":
    main()
