#!/bin/sh
# Burn the SI watermark into a demo recording (NASA Space Apps rule: SI videos carry a visible watermark).
# Usage: demo/watermark.sh INPUT OUTPUT [START_SECONDS] [DURATION_SECONDS] [RIGHT_MARGIN_PX] [TOP_MARGIN_PX]
# demo/watermark.png is rendered from demo/watermark.html; this ffmpeg build has no drawtext, so it overlays an image.
set -e
here="$(dirname "$0")"
in="$1"; out="$2"; start="${3:-0}"; duration="${4:-}"; right="${5:-20}"; top="${6:-10}"
ffmpeg -y -loglevel error -ss "$start" ${duration:+-t "$duration"} -i "$in" -i "$here/watermark.png" \
  -filter_complex "[0][1]overlay=W-w-$right:$top" -an -c:v libx264 -pix_fmt yuv420p -r 30 -movflags +faststart "$out"
echo "$out"
