#!/bin/sh
set -eu

version="$1"
architecture="$(dpkg --print-architecture)"
curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${version}/op_linux_${architecture}_v${version}.zip" -o /tmp/quaz-op.zip
unzip -q /tmp/quaz-op.zip -d /tmp/quaz-op
install -m 0755 /tmp/quaz-op/op /usr/local/bin/op
rm -rf /tmp/quaz-op /tmp/quaz-op.zip
op --version
