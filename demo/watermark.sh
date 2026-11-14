#!/bin/sh
# Burn the SI watermark into the VHS recording (NASA Space Apps rule: SI videos carry a visible watermark).
# demo/watermark.png is rendered from demo/watermark.html; this ffmpeg build has no drawtext, so it overlays an image.
set -e
cd "$(dirname "$0")"
ffmpeg -y -loglevel error -i raw.mp4 -i watermark.png \
  -filter_complex "[0][1]overlay=W-w-20:10" -c:v libx264 -pix_fmt yuv420p -movflags +faststart ulan-demo.mp4
rm -f raw.mp4
echo "demo/ulan-demo.mp4"
