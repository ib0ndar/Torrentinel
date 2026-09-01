#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tour_path="$repo_root/docs/screenshots/product-tour.gif"

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

magick -delay 240 \
  \( "$repo_root/docs/screenshots/monitor-workspace.png" -resize '960x600!' \
    -fill '#070B16E8' -stroke none -draw 'rectangle 0,498 959,599' \
    -fill '#22D3EE' -draw 'rectangle 0,498 959,502' \
    -font "$bold_font" -fill '#F4F7FC' -pointsize 28 \
    -annotate +36+556 'Watch releases and discovery rules' \
    -font "$regular_font" -fill '#8FA0C0' -pointsize 18 \
    -annotate +870+556 '1 / 3' \) \
  \( "$repo_root/docs/screenshots/subscription-details.png" -resize '960x600!' \
    -fill '#070B16E8' -stroke none -draw 'rectangle 0,498 959,599' \
    -fill '#4F7DF3' -draw 'rectangle 0,498 959,502' \
    -font "$bold_font" -fill '#F4F7FC' -pointsize 28 \
    -annotate +36+556 'See exactly what changed' \
    -font "$regular_font" -fill '#8FA0C0' -pointsize 18 \
    -annotate +870+556 '2 / 3' \) \
  \( "$repo_root/docs/screenshots/administration-diagnostics.png" -resize '960x600!' \
    -fill '#070B16E8' -stroke none -draw 'rectangle 0,498 959,599' \
    -fill '#7C3AED' -draw 'rectangle 0,498 959,502' \
    -font "$bold_font" -fill '#F4F7FC' -pointsize 28 \
    -annotate +36+556 'Audit every tracker poll' \
    -font "$regular_font" -fill '#8FA0C0' -pointsize 18 \
    -annotate +870+556 '3 / 3' \) \
  -loop 0 -layers Optimize -colors 256 "$tour_path"

printf 'Rendered %s\n' "$tour_path"
