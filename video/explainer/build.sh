#!/usr/bin/env bash
# Builds the landing page explainer from this folder: voiceover → frames → mp4, poster and thumbnail.
#   KOKORO_DIR=/path/to/kokoro-models bash video/explainer/build.sh
# Writes public/matchire-explainer.mp4, public/explainer-poster.jpg and public/explainer-thumb.jpg.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"
PY="${PYTHON:-python3}"
mkdir -p "$OUT"

# 1. Voiceover, one clip per line of lines.json.
"$PY" "$HERE/voice.py"

# 2. Frames, straight into a silent video (30 fps, 1080p). SKIP_RENDER=1 reuses the last one (sound-only changes).
if [ "${SKIP_RENDER:-}" = 1 ] && [ -f "$OUT/silent.mp4" ]; then echo "reusing $OUT/silent.mp4"; else node "$HERE/render.cjs" "$OUT/silent.mp4"; fi

# 3. Background music (made by music.py, no licence needed), as long as the video.
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/silent.mp4")
"$PY" "$HERE/music.py" "$DUR"

# 4. Each voice line starts at its scene (seconds); keep in step with the captions in index.html.
#    The music sits low and ducks further while she speaks.
OFFSETS=(0.5 4.4 9.0 16.8 22.0 27.4 31.9 36.95)
INPUTS=(); FILTER=""; MIX=""
for i in "${!OFFSETS[@]}"; do
  INPUTS+=(-i "$OUT/voice/line-$i.wav")
  ms=$(awk "BEGIN{print int(${OFFSETS[$i]}*1000)}")
  FILTER+="[$((i+1)):a]adelay=${ms}|${ms},aresample=48000[a$i];"
  MIX+="[a$i]"
done
M=$(( ${#OFFSETS[@]} + 1 ))
FILTER+="${MIX}amix=inputs=${#OFFSETS[@]}:normalize=0,apad,atrim=0:${DUR},aformat=channel_layouts=stereo,asplit[vox][key];"
FILTER+="[$M:a]volume=0.1[bed];[bed][key]sidechaincompress=threshold=0.02:ratio=4:attack=30:release=600[duck];"
FILTER+="[vox][duck]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]"
ffmpeg -v error -y -i "$OUT/silent.mp4" "${INPUTS[@]}" -i "$OUT/music.wav" -filter_complex "$FILTER" -map 0:v -map "[aout]" \
  -c:v copy -c:a aac -profile:a aac_low -ar 48000 -b:a 128k -movflags +faststart "$ROOT/public/matchire-explainer.mp4"

# 5. Poster (the quote scene) and the small thumbnail on the landing page button.
ffmpeg -v error -y -ss 15.5 -i "$ROOT/public/matchire-explainer.mp4" -frames:v 1 -vf scale=1280:720 -q:v 3 "$ROOT/public/explainer-poster.jpg"
ffmpeg -v error -y -ss 15.5 -i "$ROOT/public/matchire-explainer.mp4" -frames:v 1 -vf scale=240:135 -q:v 4 "$ROOT/public/explainer-thumb.jpg"

ls -l "$ROOT/public/matchire-explainer.mp4"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$ROOT/public/matchire-explainer.mp4"
