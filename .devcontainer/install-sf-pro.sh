#!/usr/bin/env bash

set -euo pipefail

font_directory="/usr/local/share/fonts/clanky-sf-pro"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -s "${font_directory}/SF-Pro.ttf" ||
  ! -s "${font_directory}/SF-Pro-Italic.ttf" ||
  ! -f "${font_directory}/License.rtf" ]]; then
  temp_directory="$(mktemp -d)"
  trap 'rm -rf -- "${temp_directory}"' EXIT

  echo "Downloading SF Pro from Apple for local development..."
  curl --fail --location --silent --show-error \
    --connect-timeout 15 --max-time 300 \
    https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg \
    -o "${temp_directory}/SF-Pro.dmg"
  7z x -y -bd -bso0 -bsp0 "${temp_directory}/SF-Pro.dmg" \
    "-o${temp_directory}/disk" SFProFonts.pkg
  7z x -txar -y -bd -bso0 -bsp0 "${temp_directory}/disk/SFProFonts.pkg" \
    "-o${temp_directory}/package" \
    SFProFontsPackage.pkg/Payload Resources/English.lproj/License.rtf
  mkdir "${temp_directory}/fonts"
  bsdtar -xf "${temp_directory}/package/SFProFontsPackage.pkg/Payload" \
    -C "${temp_directory}/fonts" \
    ./Library/Fonts/SF-Pro.ttf ./Library/Fonts/SF-Pro-Italic.ttf

  sudo install -d "${font_directory}"
  sudo install -m 644 \
    "${temp_directory}/fonts/Library/Fonts/SF-Pro.ttf" \
    "${temp_directory}/fonts/Library/Fonts/SF-Pro-Italic.ttf" \
    "${temp_directory}/package/Resources/English.lproj/License.rtf" \
    "${font_directory}/"
fi

sudo install -m 644 "${script_directory}/sf-pro-fontconfig.conf" \
  /etc/fonts/conf.d/99-clanky-sf-pro.conf
sudo fc-cache -f

echo "SF Pro is installed and selected for local development UI text."
