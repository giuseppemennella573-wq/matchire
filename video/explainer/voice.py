# Voiceover for the explainer: one WAV per line in lines.json, in the same
# female voice as before (Kokoro "af_heart", 1.18x by default; VOICE_SPEED overrides it). Prints each line's length.
# Needs kokoro-onnx and soundfile, plus kokoro.onnx and voices.bin in $KOKORO_DIR (see README).
import json, os, sys, soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
models = os.environ.get("KOKORO_DIR", os.path.join(here, "models"))
k = Kokoro(os.path.join(models, "kokoro.onnx"), os.path.join(models, "voices.bin"))
out_dir = os.path.join(here, "out", "voice")
os.makedirs(out_dir, exist_ok=True)
lengths = {}
for i, text in enumerate(json.load(open(os.path.join(here, "lines.json")))):
    samples, sr = k.create(text, voice="af_heart", speed=float(os.environ.get("VOICE_SPEED", "1.18")), lang="en-us")
    sf.write(os.path.join(out_dir, f"line-{i}.wav"), samples, sr)
    lengths[i] = round(len(samples) / sr, 2)
print(json.dumps(lengths))
