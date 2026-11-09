"""
Builds the Anvil product video: neural voice-over + motion graphics + real recorded footage.

  python video/build.py --clips <dir with taskA.mp4, agent.mp4, taskC.mp4, securityClip.mp4> [--ffmpeg path]

Pipeline
  1. Voice-over: edge-tts (Microsoft neural voice) per scene from narration.json.
  2. Motion graphics: scenes.html rendered deterministically, frame by frame, with Playwright (1920x1080 @ 30fps).
  3. Footage: each recorded clip is fitted to its narration. Longer clips are sped up uniformly and get an
     on-screen "sped up xN" badge, so nothing is presented as faster than it ran. Shorter ones hold the last frame.
  4. Captions (drawtext) on footage, then all segments joined with crossfades (video and audio).
"""
import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
FPS = 30
W, H = 1920, 1080
XFADE = 0.5
FONT = "C\\:/Windows/Fonts/segoeuib.ttf"


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(" ".join(map(str, cmd))[:400])
        print(r.stderr[-3000:])
        sys.exit(1)
    return r.stdout


def duration(ffprobe, path):
    return float(run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).strip())


async def tts(scenes, voice, rate):
    import edge_tts

    out = BUILD / "audio"
    out.mkdir(parents=True, exist_ok=True)
    for s in scenes:
        f = out / f"{s['id']}.mp3"
        if f.exists() and f.with_suffix(".txt").exists() and f.with_suffix(".txt").read_text(encoding="utf-8") == s["text"]:
            continue
        for attempt in range(5):  # the TTS service fails intermittently; retry with backoff
            try:
                await edge_tts.Communicate(s["text"], voice, rate=rate).save(str(f))
                break
            except Exception as e:
                if attempt == 4:
                    raise
                print(f"  voice retry {s['id']}: {type(e).__name__}")
                await asyncio.sleep(2 * (attempt + 1))
        f.with_suffix(".txt").write_text(s["text"], encoding="utf-8")
        print(f"  voice: {s['id']}")


def render_graphic(ffmpeg, scene_id, seconds, out):
    from playwright.sync_api import sync_playwright

    frames = int(round(seconds * FPS))
    enc = subprocess.Popen(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "png", "-i", "-",
         "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", str(FPS), str(out)],
        stdin=subprocess.PIPE,
    )
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        page.goto((ROOT / "scenes.html").as_uri())
        page.wait_for_timeout(300)
        for i in range(frames):
            page.evaluate(f"window.render('{scene_id}', {i / FPS}, {seconds})")
            enc.stdin.write(page.screenshot(type="png"))
        b.close()
    enc.stdin.close()
    enc.wait()


def fit_footage(ffmpeg, ffprobe, clip, seconds, caption, out, speed_note=None):
    L = duration(ffprobe, clip)
    speed = L / seconds
    vf = []
    if speed > 1.02:
        vf.append(f"setpts=PTS/{speed:.4f}")
    vf.append(f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17")
    if speed < 0.98:
        vf.append(f"tpad=stop_mode=clone:stop_duration={seconds - L + 0.2:.2f}")
    vf.append(f"fps={FPS}")
    alpha = f"if(lt(t,0.3),0,if(lt(t,0.8),(t-0.3)/0.5,if(gt(t,{seconds - 0.6:.2f}),max(0,({seconds:.2f}-t)/0.6),1)))"
    vf.append(f"drawtext=fontfile='{FONT}':text='  {caption}  ':fontsize=34:fontcolor=white:box=1:boxcolor=0x121826@0.92:boxborderw=18:x=40:y=36:alpha='{alpha}'")
    badge = speed_note or (f"sped up x{speed:.1f}" if speed > 1.15 else None)
    if badge:
        vf.append(f"drawtext=fontfile='{FONT}':text='  {badge}  ':fontsize=26:fontcolor=0xb8c2d6:box=1:boxcolor=0x121826@0.92:boxborderw=14:x=w-tw-60:y=40:alpha='{alpha}'")
    run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(clip), "-an", "-vf", ",".join(vf), "-t", f"{seconds:.3f}",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(out)])
    return speed


def mux(ffmpeg, video, audio, seconds, out):
    # Narration starts 0.35s in; audio is padded to the segment length.
    run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(video), "-i", str(audio),
         "-filter_complex", f"[1:a]adelay=350|350,apad,atrim=0:{seconds:.3f},aformat=sample_rates=48000:channel_layouts=stereo[a]",
         "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{seconds:.3f}", str(out)])


def join(ffmpeg, segs, durs, out):
    inputs = []
    for s in segs:
        inputs += ["-i", str(s)]
    fc = []
    v, a, t = "[0:v]", "[0:a]", durs[0]
    for i in range(1, len(segs)):
        off = t - XFADE
        fc.append(f"{v}[{i}:v]xfade=transition=fade:duration={XFADE}:offset={off:.3f}[v{i}]")
        fc.append(f"{a}[{i}:a]acrossfade=d={XFADE}[a{i}]")
        v, a = f"[v{i}]", f"[a{i}]"
        t = t + durs[i] - XFADE
    run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", ";".join(fc), "-map", v, "-map", a,
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", str(out)])
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True)
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    ap.add_argument("--out", default=str(ROOT / "out" / "anvil-product-video.mp4"))
    ap.add_argument("--only", default="", help="comma-separated scene ids (for previews)")
    args = ap.parse_args()
    ffmpeg = args.ffmpeg
    ffprobe = str(Path(ffmpeg).with_name("ffprobe" + Path(ffmpeg).suffix))
    cfg = json.loads((ROOT / "narration.json").read_text(encoding="utf-8"))
    scenes = [s for s in cfg["scenes"] if not args.only or s["id"] in args.only.split(",")]
    clips = Path(args.clips)
    scenes = [s for s in scenes if s["kind"] == "graphic" or (clips / f"{s['id']}.mp4").exists()]
    BUILD.mkdir(exist_ok=True)
    (ROOT / "out").mkdir(exist_ok=True)

    print("1/4 voice-over")
    asyncio.run(tts(scenes, cfg["voice"], cfg["rate"]))
    segs, durs = [], []
    for s in scenes:
        audio = BUILD / "audio" / f"{s['id']}.mp3"
        seconds = duration(ffprobe, audio) + 1.1
        vid = BUILD / f"{s['id']}.video.mp4"
        if s["kind"] == "graphic":
            import hashlib
            key = hashlib.sha256((s["text"] + f"{seconds:.3f}" + (ROOT / "scenes.html").read_text(encoding="utf-8") + (ROOT / "scenes2.js").read_text(encoding="utf-8")).encode()).hexdigest()
            keyf = BUILD / f"{s['id']}.video.key"
            if vid.exists() and keyf.exists() and keyf.read_text() == key:
                print(f"2/4 motion graphics: {s['id']} (cached)")
            else:
                print(f"2/4 motion graphics: {s['id']} ({seconds:.1f}s)")
                render_graphic(ffmpeg, s["id"], seconds, vid)
                keyf.write_text(key)
        else:
            sp = fit_footage(ffmpeg, ffprobe, clips / f"{s['id']}.mp4", seconds, s["caption"], vid, s.get("speedNote"))
            print(f"3/4 footage: {s['id']} ({seconds:.1f}s, speed x{sp:.2f})")
        seg = BUILD / f"{s['id']}.seg.mp4"
        mux(ffmpeg, vid, audio, seconds, seg)
        segs.append(seg)
        durs.append(seconds)
    print("4/4 joining")
    total = join(ffmpeg, segs, durs, Path(args.out))
    print(f"done: {args.out} ({total:.1f}s)")


if __name__ == "__main__":
    main()
