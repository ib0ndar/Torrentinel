#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
preview_path="$repo_root/docs/social-preview.png"

if [ -f "/System/Library/Fonts/Supplemental/Arial Bold.ttf" ]; then
  bold_font="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
  regular_font="/System/Library/Fonts/Supplemental/Arial.ttf"
elif command -v fc-match >/dev/null 2>&1; then
  bold_font=$(fc-match -f '%{file}\n' 'Arial:style=Bold' | sed -n '1p')
  regular_font=$(fc-match -f '%{file}\n' 'Arial:style=Regular' | sed -n '1p')
else
  printf 'Unable to locate a usable sans-serif font\n' >&2
  exit 1
fi

magick \
  -size 1280x640 gradient:'#070B16-#11142B' \
  -fill none -stroke '#4F7DF326' -strokewidth 2 \
  -draw 'circle 1158,98 1408,98 circle 1158,98 1343,98' \
  \( \
    \( "$repo_root/docs/screenshots/monitor-workspace.png" \
      -crop 1315x1000+285+0 +repage -resize '610x464!' \) \
    \( -size 610x464 xc:none -fill white -stroke none \
      -draw 'roundrectangle 0,0 609,463 22,22' \) \
    -alpha off -compose CopyOpacity -composite \
  \) \
  -gravity northwest -geometry +610+88 -compose over -composite \
  -fill none -stroke '#2A3C64' -strokewidth 2 \
  -draw 'roundrectangle 610,88 1220,552 22,22' \
  \( "$repo_root/public/brand/png/torrentinel-lockup.png" -resize '430x100!' \) \
  -gravity northwest -geometry +54+40 -compose over -composite \
  -font "$bold_font" -fill '#F4F7FC' -stroke none -pointsize 44 \
  -annotate +64+244 'Monitor torrent releases.' \
  -fill '#22D3EE' \
  -annotate +64+306 'Know when they change.' \
  -font "$regular_font" -fill '#9BA9C4' -pointsize 22 \
  -annotate +66+360 'Private history · phrase discovery · Telegram alerts' \
  -fill '#101A31' -stroke '#22D3EE61' -strokewidth 1 \
  -draw 'roundrectangle 64,442 212,486 22,22' \
  -stroke '#4F7DF373' \
  -draw 'roundrectangle 224,442 324,486 22,22' \
  -stroke '#7C3AED80' \
  -draw 'roundrectangle 336,442 428,486 22,22' \
  -font "$bold_font" -fill '#C8F8FF' -stroke none -pointsize 17 \
  -annotate +70+470 'Docker Compose' \
  -fill '#DCE6FF' \
  -annotate +245+470 'Podman' \
  -fill '#E8DDFF' \
  -annotate +359+470 'Linux' \
  -fill '#4F7DF3' -stroke none \
  -draw 'roundrectangle 64,548 494,552 2,2' \
  -font "$regular_font" -fill '#7383A3' -pointsize 17 \
  -annotate +64+590 'RUTRACKER · RUTOR · KINOZAL' \
  -depth 8 -strip -define png:compression-level=9 "$preview_path"

printf 'Rendered %s\n' "$preview_path"
