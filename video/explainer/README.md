# Landing page explainer

The source of `public/matchire-explainer.mp4` (about 42 s, 1920×1080, 30 fps, with a female
voiceover, background music and captions), plus its poster and thumbnail.

```
KOKORO_DIR=/path/to/kokoro-models bash video/explainer/build.sh
```

That one command makes the voiceover, renders every frame and writes
`public/matchire-explainer.mp4`, `public/explainer-poster.jpg` and `public/explainer-thumb.jpg`.

## Files

| File | What it is |
|---|---|
| `index.html` | The video: eight scenes on a timeline. Each element has `data-in` / `data-out` times in seconds; `render(t)` draws the frame at time `t`. Open it in a browser and call `render(12)` in the console to see a moment. |
| `lines.json` | The voiceover, one line per scene. "Match-hire" and "dot A.I." are spelled that way so the voice says them right. |
| `voice.py` | Turns `lines.json` into `out/voice/line-N.wav` (Kokoro, voice `af_heart`, 1.12×) and prints each length. |
| `render.cjs` | Renders `index.html` frame by frame with Playwright, piped straight into ffmpeg (no frame dumps). |
| `frames.cjs` | Stills for checking: `node video/explainer/frames.cjs 3 15.5 25` → `out/still-3.png` … |
| `music.py` | Makes the background music from scratch (synth pad, soft bass, light beat, pluck arpeggio; 96 bpm), so there's no licence to check. `out/music.wav`. |
| `build.sh` | Runs all of the above, mixes each voice line in at its scene over the music (which ducks while she speaks) and writes the outputs. `SKIP_RENDER=1` reuses the last frames render when only the sound changed. |

When you change a line, run `voice.py` to see its new length, then check the scene times in
`index.html` and the `OFFSETS` in `build.sh` still fit.

## Setup (once)

- Node with Playwright (`require('playwright')` must work) and ffmpeg on the PATH.
- Python 3 with `pip install kokoro-onnx soundfile` (numpy comes with them; `music.py` needs nothing else).
- The Kokoro model files `kokoro.onnx` and `voices.bin` from
  https://github.com/thewh1teagle/kokoro-onnx/releases (model files v1.0), in `video/explainer/models/`
  or wherever `KOKORO_DIR` points. They're about 350 MB, so they aren't in git.
- Set `PYTHON=/path/to/python` if Kokoro is installed in a virtualenv.

`out/` (stills, voice clips, the silent render) is ignored by git.

## Rules for what the video says

It's site copy, so `docs/positioning.md` applies: only features marked Live, prices exactly as on
the landing page (Solo S$79/month, free during early access, 30% off the first year), no Instagram
(it's Coming soon).
