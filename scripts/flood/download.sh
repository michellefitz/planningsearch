#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="$DIR/data"
mkdir -p "$DATA"

NIFM_URL="https://s3.eu-west-1.amazonaws.com/catalogue.floodinfo.opw/nifm/nifm_ext_f_c.zip"
NCFHM_URL="https://s3.eu-west-1.amazonaws.com/catalogue.floodinfo.opw/ncfhm_itm_ext_c_c_1000yr_200yr_10yr.zip"

echo "Downloading NIFM (fluvial flood extents, current scenario)..."
curl -L -o "$DATA/nifm.zip" "$NIFM_URL"
unzip -o "$DATA/nifm.zip" -d "$DATA/nifm"

echo "Downloading NCFHM (coastal flood extents, current scenario)..."
curl -L -o "$DATA/ncfhm.zip" "$NCFHM_URL"
unzip -o "$DATA/ncfhm.zip" -d "$DATA/ncfhm"

echo "Done. Run build.mjs next."
