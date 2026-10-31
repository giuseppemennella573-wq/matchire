# Background music for the explainer, made from scratch here so there's no licence to worry about:
# an upbeat pop groove in E major (E · B · C#m · A), 118 bpm: bright pad, bouncy eighth-note bass,
# four-on-the-floor kick, claps on 2 and 4, sixteenth hi-hats and a pluck arpeggio. One chord per bar.
# The same seed always gives the same track.
#   python music.py 42.5   →  out/music.wav
import os, sys
import numpy as np
import soundfile as sf

SR = 48000
BPM = 118
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)

def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)

CHORDS = [  # MIDI notes: pad voicing, bass root
    ([64, 68, 71, 76], 40),  # E
    ([63, 66, 71, 75], 35),  # B
    ([64, 68, 73, 76], 37),  # C#m
    ([64, 69, 73, 76], 33),  # A
]

def lowpass(x, cutoff):
    """Gentle low-pass in the frequency domain (fine for a whole, short track)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (f / cutoff) ** 4)
    return np.fft.irfft(X, len(x))

def highpass(x, cutoff):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (cutoff / np.maximum(f, 1e-6)) ** 4)
    return np.fft.irfft(X, len(x))

def add(buf, start, sig):
    i = int(start * SR)
    if i >= len(buf):
        return
    n = min(len(sig), len(buf) - i)
    buf[i:i + n] += sig[:n]

def pad_note(f, dur):
    t = np.arange(int(dur * SR)) / SR
    s = np.zeros_like(t)
    for detune in (-0.06, 0.0, 0.06):  # three slightly detuned saws, built from harmonics
        ff = f * 2 ** (detune / 12)
        for h in range(1, 9):
            s += np.sin(2 * np.pi * ff * h * t + rng.uniform(0, 2 * np.pi)) / h
    att, rel = 0.6, 0.5
    env = np.minimum(1, t / att) * np.minimum(1, (dur - t) / rel)
    return s * np.clip(env, 0, 1)

def bass_note(f, dur):
    t = np.arange(int(dur * SR)) / SR
    s = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)
    return s * np.exp(-t * 2.2) * np.minimum(1, t / 0.01) * np.clip((dur - t) / 0.01, 0, 1)

def kick():
    t = np.arange(int(0.35 * SR)) / SR
    f = 45 + 75 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11)

def hat():
    t = np.arange(int(0.05 * SR)) / SR
    return rng.standard_normal(len(t)) * np.exp(-t * 90)

def clap():
    t = np.arange(int(0.2 * SR)) / SR
    n = rng.standard_normal(len(t))
    env = np.exp(-t * 28) + 0.6 * np.exp(-np.maximum(t - 0.012, 0) * 40) * (t > 0.012)
    return n * env

def pluck(f):
    t = np.arange(int(0.45 * SR)) / SR
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.15 * np.sin(6 * np.pi * f * t)
    return s * np.exp(-t * 9) * np.minimum(1, t / 0.004)

def make(duration):
    n = int(duration * SR)
    pad, bass, drums, hats, arp, claps = (np.zeros(n) for _ in range(6))
    bars = int(np.ceil(duration / BAR))
    for b in range(bars):
        notes, root = CHORDS[b % 4]
        t0 = b * BAR
        for m in notes:
            add(pad, t0, pad_note(hz(m), BAR + 0.5))
        last = b >= bars - 1  # the beat drops out for the final bar
        if not last:  # the groove runs from the first bar; it drops out for the final one
            for beat in range(4):
                add(drums, t0 + beat * BEAT, kick())
                if beat in (1, 3):
                    add(claps, t0 + beat * BEAT, clap())
                for s16 in range(4):
                    add(hats, t0 + beat * BEAT + s16 * BEAT / 4, hat() * (1.0 if s16 == 2 else 0.45))
            for e8 in range(8):  # bouncy eighths, octave jump on the offbeats
                add(bass, t0 + e8 * BEAT / 2, bass_note(hz(root + (12 if e8 % 2 else 0)), BEAT / 2))
        if b >= 1 and not last:
            pattern = [notes[0] + 12, notes[2] + 12, notes[1] + 12, notes[3] + 12] * 4
            for k, m in enumerate(pattern):
                add(arp, t0 + k * BEAT / 4, pluck(hz(m)) * (1.0 if k % 4 == 0 else 0.6))
    pad = lowpass(pad, 3200)
    hats = highpass(hats, 7000)
    claps = highpass(lowpass(claps, 6000), 900)
    mix = 0.09 * pad / np.max(np.abs(pad)) * 3 + 0.45 * bass / np.max(np.abs(bass)) \
        + 0.6 * drums / np.max(np.abs(drums)) + 0.14 * hats / np.max(np.abs(hats)) \
        + 0.3 * claps / np.max(np.abs(claps)) + 0.2 * lowpass(arp, 4500) / np.max(np.abs(arp))
    t = np.arange(n) / SR
    mix *= np.minimum(1, t / 0.3) * np.clip((duration - t) / 2.0, 0, 1)  # straight in, fade out 2s
    mix /= np.max(np.abs(mix)) / 0.9
    return np.stack([mix, mix], axis=1)

if __name__ == "__main__":
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 42.5
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "music.wav")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sf.write(out, make(duration).astype(np.float32), SR)
    print(out)
