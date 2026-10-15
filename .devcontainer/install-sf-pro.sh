#!/usr/bin/env bash

set -euo pipefail

archive_sha256="968ab3b8b1f92c2d8af61eb0680f5c2224c4e78d59b986bf004502a7fc012918"
font_directory="/usr/local/share/fonts/clanky-sf-pro"
source_marker="${font_directory}/.archive-sha256"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -s "${font_directory}/SF-Pro.ttf" ||
  ! -s "${font_directory}/SF-Pro-Italic.ttf" ||
  ! -f "${font_directory}/License.rtf" ||
  ! -f "${source_marker}" ||
  "$(cat "${source_marker}")" != "${archive_sha256}" ]]; then
  temp_directory="$(mktemp -d)"
  trap 'rm -rf -- "${temp_directory}"' EXIT

  echo "Downloading SF Pro from Apple for local development..."
  curl --fail --location --silent --show-error \
    --connect-timeout 15 --max-time 300 \
    https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg \
    -o "${temp_directory}/SF-Pro.dmg"
  printf '%s  %s\n' "${archive_sha256}" "${temp_directory}/SF-Pro.dmg" |
    sha256sum --check

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
  printf '%s\n' "${archive_sha256}" | sudo tee "${source_marker}" >/dev/null
fi

sudo install -m 644 "${script_directory}/sf-pro-fontconfig.conf" \
  /etc/fonts/conf.d/99-clanky-sf-pro.conf
sudo fc-cache -f

for family in ui-sans-serif system-ui sans-serif; do
  resolved_family="$(fc-match -f '%{family}' "${family}")"
  if [[ "${resolved_family}" != "SF Pro" ]]; then
    echo "SF Pro setup failed: ${family} resolved to ${resolved_family}." >&2
    exit 1
  fi
done

echo "SF Pro is installed and selected for local development UI text."
