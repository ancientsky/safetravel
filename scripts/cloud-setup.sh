#!/usr/bin/env bash
# Cloud environment setup for SafeTravel TW: Node.js 26 and Python 3.14, the versions in .nvmrc /
# .python-version and GitHub Actions. Paste this into the cloud environment's "Setup script"
# (environment menu in the session title bar → Edit); it runs at the start of every new session.
# Idempotent: a second run only re-checks the versions.
set -euo pipefail

NODE_VERSION=v26.13.1
NODE_SHA256=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864   # nodejs.org SHASUMS256.txt
PY_VERSION=3.14.9
UV_VERSION=0.13.5
BIN="${HOME:-/root}/.local/bin"   # first on PATH in this image, ahead of /opt/node22/bin and /usr/bin
mkdir -p "$BIN"

# ---- Node.js 26: official build, checksum-verified
if [ "$(/opt/node26/bin/node --version 2>/dev/null)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSLo "$tmp/node.tar.xz" "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
  echo "${NODE_SHA256}  $tmp/node.tar.xz" | sha256sum -c -
  rm -rf /opt/node26 && mkdir -p /opt/node26
  tar -xJf "$tmp/node.tar.xz" -C /opt/node26 --strip-components=1
  rm -rf "$tmp"
fi
echo 'export PATH=/opt/node26/bin:$PATH' > /etc/profile.d/nodejs.sh
for b in node npm npx; do   # Node.js 25 and later no longer ship corepack
  ln -sf "/opt/node26/bin/$b" "/usr/local/bin/$b"
  ln -sf "/opt/node26/bin/$b" "$BIN/$b"
done

# ---- Python 3.14: uv-managed CPython in a venv (so `python -m pip` works); the system python3 is left alone
if [ ! -x "$BIN/uv" ] || [ "$("$BIN/uv" --version | cut -d' ' -f2)" != "$UV_VERSION" ]; then
  /usr/bin/python3 -m pip install -q --user --break-system-packages "uv==${UV_VERSION}" 2>/dev/null \
    || /usr/bin/python3 -m pip install -q --user "uv==${UV_VERSION}"
fi
if [ "$(/opt/py314/bin/python --version 2>/dev/null)" != "Python ${PY_VERSION}" ]; then
  "$BIN/uv" python install "$PY_VERSION"
  rm -rf /opt/py314
  "$BIN/uv" venv --quiet --seed --python "$PY_VERSION" /opt/py314
fi
# wrappers (not symlinks) so sys.executable stays inside the venv
for name in python python3; do
  printf '#!/bin/sh\nexec /opt/py314/bin/python "$@"\n' > "$BIN/$name"
done
for name in pip pip3; do
  printf '#!/bin/sh\nexec /opt/py314/bin/python -m pip "$@"\n' > "$BIN/$name"
done
chmod +x "$BIN/python" "$BIN/python3" "$BIN/pip" "$BIN/pip3"

echo "node $(node --version) · npm $(npm --version) · $(python --version)"
