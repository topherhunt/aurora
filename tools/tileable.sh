#!/bin/bash
# Make a texture tile seamlessly, or roll one to inspect its seams.
#
#   tile  -- rolls the image a half-tile so the wrap seam lands in the middle,
#            then composites the untouched original back over the centre through
#            a soft-edged mask. The border of the result is rolled content, whose
#            left and right (top and bottom) columns were adjacent in the source,
#            so the output wraps cleanly. The blend hides the swap.
#   roll  -- just the half-tile roll. Run it on a -tiled file: whatever was on the
#            border moves to the centre, where a bad blend is obvious.
#
# Works on any size; the mask inset and blur are fractions of the image. Keep
# blur under a third of inset: a wider gaussian reaches the border, letting the
# original's non-wrapping edge back in, and the result stops tiling.

set -euo pipefail

INSET=0.04    # white rectangle inset from each edge, as a fraction of that axis
BLUR=0.039    # mask blur sigma, as a fraction of the shorter axis
MODE=tile
IN=""
OUT=""

usage() {
  cat <<'EOF'
Usage: tools/tileable.sh [tile|roll] <input.png> [output.png] [options]

Modes (default: tile)
  tile              blend the image so it tiles seamlessly  -> <input>-tiled.png
  roll              shift by half a tile to expose the seams -> <input>-rolled.png

Options
  -o, --out FILE    output path (same as the positional output argument)
      --inset F     mask inset per edge, fraction of the axis (default 0.04)
      --blur F      mask blur sigma, fraction of the shorter axis (default 0.039)
  -h, --help        this text

Examples
  tools/tileable.sh grass.png                  # -> grass-tiled.png
  tools/tileable.sh roll grass-tiled.png       # -> grass-tiled-rolled.png, eyeball it
  tools/tileable.sh tile bark.png bark_t.png --blur 0.08
EOF
}

case "${1:-}" in
  tile|roll) MODE="$1"; shift ;;
  -h|--help) usage; exit 0 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -o|--out)  OUT="$2"; shift 2 ;;
    --inset)   INSET="$2"; shift 2 ;;
    --blur)    BLUR="$2"; shift 2 ;;
    -*)        echo "tileable: unknown option $1" >&2; exit 2 ;;
    *)
      if   [ -z "$IN" ];  then IN="$1"
      elif [ -z "$OUT" ]; then OUT="$1"
      else echo "tileable: unexpected argument $1" >&2; exit 2
      fi
      shift ;;
  esac
done

[ -n "$IN" ] || { usage; exit 2; }
[ -f "$IN" ] || { echo "tileable: no such file: $IN" >&2; exit 1; }
command -v magick >/dev/null || { echo "tileable: ImageMagick 7 (magick) not found" >&2; exit 1; }

if [ -z "$OUT" ]; then
  ext="${IN##*.}"
  base="${IN%.*}"
  if [ "$ext" = "$IN" ]; then base="$IN"; ext="png"; fi
  if [ "$MODE" = roll ]; then suffix=rolled; else suffix=tiled; fi
  OUT="$base-$suffix.$ext"
fi

read -r W H < <(magick identify -format '%w %h\n' "$IN[0]")
HW=$((W / 2))
HH=$((H / 2))

if [ "$MODE" = roll ]; then
  magick "$IN" -roll "+$HW+$HH" "$OUT"
  echo "$OUT  (${W}x${H}, rolled +$HW+$HH)"
  exit 0
fi

# Mask geometry, clamped so the white rectangle never inverts on a thin image.
read -r X0 Y0 X1 Y1 SIGMA < <(awk -v w="$W" -v h="$H" -v inset="$INSET" -v blur="$BLUR" 'BEGIN {
  x = int(w * inset); y = int(h * inset);
  if (x > w / 2 - 1) x = int(w / 2) - 1;
  if (y > h / 2 - 1) y = int(h / 2) - 1;
  if (x < 0) x = 0; if (y < 0) y = 0;
  short = (w < h ? w : h);
  s = short * blur; if (s < 0.5) s = 0.5;
  printf "%d %d %d %d %.2f\n", x, y, w - 1 - x, h - 1 - y, s;
}')

# Destination = rolled, source = original, third image = mask: the source shows
# through where the mask is white (the centre), the rolled copy where it is black.
magick "$IN" -roll "+$HW+$HH" \
  "$IN" \
  \( -size "${W}x${H}" xc:black -fill white -draw "rectangle $X0,$Y0 $X1,$Y1" -blur "0x$SIGMA" -alpha off \) \
  -composite "$OUT"

echo "$OUT  (${W}x${H}, roll +$HW+$HH, mask $X0,$Y0 $X1,$Y1 blur 0x$SIGMA)"
