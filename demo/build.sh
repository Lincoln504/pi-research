#!/usr/bin/env bash
# Render every tape in tapes/ to out/*.gif, then optimize with gifsicle.
# Usage: ./build.sh            # all tapes
#        ./build.sh 01 03      # only tapes whose name starts with 01 / 03
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
mkdir -p out

command -v vhs >/dev/null || { echo "vhs not on PATH (expected ~/.local/bin/vhs)"; exit 1; }

select_tapes() {
  if [ "$#" -eq 0 ]; then ls tapes/*.tape; return; fi
  for pfx in "$@"; do ls tapes/"$pfx"*.tape 2>/dev/null || true; done
}

for tape in $(select_tapes "$@"); do
  name=$(basename "$tape" .tape)
  echo ">> rendering $name"
  vhs "$tape"
done

if command -v gifsicle >/dev/null; then
  echo ">> optimizing with gifsicle"
  for g in out/*.gif; do
    [ -f "$g" ] || continue
    before=$(stat -c%s "$g")
    gifsicle -O3 --lossy=60 --colors 200 "$g" -o "$g.opt" && mv "$g.opt" "$g"
    after=$(stat -c%s "$g")
    printf "   %-28s %6d KB -> %6d KB\n" "$(basename "$g")" $((before/1024)) $((after/1024))
  done
else
  echo "gifsicle not found; skipping optimization (apt install gifsicle)"
fi
echo ">> done -> demo/out/"
