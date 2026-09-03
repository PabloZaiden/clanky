#!/usr/bin/env bash

set -euo pipefail

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required to install Chromium in the devcontainer." >&2
  exit 1
fi

if command -v chromium >/dev/null 2>&1 &&
  chromium --version >/dev/null 2>&1 &&
  command -v sshpass >/dev/null 2>&1 &&
  command -v dtach >/dev/null 2>&1; then
  echo "Chromium is already installed."
  exit 0
fi

architecture="$(dpkg --print-architecture)"
case "${architecture}" in
  amd64) cft_platform="linux64" ;;
  arm64) cft_platform="linux-arm64" ;;
  *)
    echo "Unsupported target architecture: ${architecture}. Expected amd64 or arm64." >&2
    exit 1
    ;;
esac

echo "Installing Chromium dependencies..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dtach \
  fonts-liberation \
  fonts-noto-color-emoji \
  jq \
  libasound2t64 \
  libatk-bridge2.0-0t64 \
  libatk1.0-0t64 \
  libcups2t64 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0t64 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  sshpass \
  unzip

sudo rm -rf /var/lib/apt/lists/*

if command -v chromium >/dev/null 2>&1 && chromium --version >/dev/null 2>&1; then
  echo "Chromium is already installed."
  exit 0
fi

# Always use the newest known-good Chrome for Testing release.
download_url="$(
  curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json |
    jq -er --arg platform "${cft_platform}" \
      '[.versions[] | select(any(.downloads["chrome-headless-shell"][]?; .platform == $platform))] | max_by(.version | split(".") | map(tonumber)) | .downloads["chrome-headless-shell"][] | select(.platform == $platform) | .url'
)"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
curl -fsSL "${download_url}" -o "${temp_dir}/chrome.zip"
unzip -q "${temp_dir}/chrome.zip" -d "${temp_dir}"

browser_dir="$(find "${temp_dir}" -mindepth 1 -maxdepth 1 -type d -name 'chrome-headless-shell-*' -print -quit)"
if [[ -z "${browser_dir}" ]]; then
  echo "Chromium archive did not contain a headless shell." >&2
  exit 1
fi

sudo rm -rf /opt/chrome-headless-shell
sudo install -d /opt/chrome-headless-shell
sudo cp -a "${browser_dir}/." /opt/chrome-headless-shell/
sudo ln -sfn /opt/chrome-headless-shell/chrome-headless-shell /usr/local/bin/chromium
chromium --version
