#!/bin/sh
# Install the Pipelines extension into a Pi Pocket data folder, then turn it on in Menu → Extensions.
set -eu
dest="${PI_POCKET_DIR:-$HOME/.pi-pocket}/extensions"
mkdir -p "$dest/pipelines"
cp pipelines.ts "$dest/pipelines.ts"
cp pipelines/index.js pipelines/style.css "$dest/pipelines/"
echo "Installed into $dest — now enable “Pipelines” in Pi Pocket: Menu → Extensions."
