#!/usr/bin/env bash
# Resumable parallel download of FIRMS global yearly SP zips. Verifies size against Content-Length.
OUT="$1"; P="${2:-6}"; B="https://firms.modaps.eosdis.nasa.gov/data/country/zips"
cd "$OUT" || exit 1
list() { for y in $(seq 2000 2025); do echo "modis_${y}_all_countries.zip"; done
         for y in $(seq 2012 2025); do echo "viirs-snpp_${y}_all_countries.zip"; done
         for y in $(seq 2018 2025); do echo "viirs-jpss1_${y}_all_countries.zip"; done; }
one() { f="$1"; B="$2"
  exp=$(curl -sIL --max-time 60 "$B/$f" | awk 'BEGIN{IGNORECASE=1}/content-length/{l=$2}END{gsub("\r","",l);print l}')
  for attempt in 1 2 3 4 5 6; do
    have=$(stat -c %s "$f" 2>/dev/null || echo 0)
    [ -n "$exp" ] && [ "$have" = "$exp" ] && { echo "OK $f $have"; return 0; }
    curl -sL -C - --retry 5 --retry-delay 10 --max-time 7200 -o "$f" "$B/$f"
  done
  echo "FAIL $f have=$(stat -c %s "$f" 2>/dev/null) exp=$exp"; return 1; }
export -f one
list | xargs -P "$P" -I{} bash -c 'one "$@"' _ {} "$B"
echo "DONE $(date -u +%FT%TZ)"
