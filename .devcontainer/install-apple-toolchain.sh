#!/usr/bin/env bash

set -euo pipefail

source /etc/os-release
if [[ "$ID" != "ubuntu" || "$VERSION_ID" != "24.04" ]]; then
  echo "The devcontainer Apple toolchain requires Ubuntu 24.04." >&2
  exit 1
fi

swift_version="6.4.2"
xtool_version="1.24.0"
case "$(dpkg --print-architecture)" in
  amd64)
    swift_platform="ubuntu2404"
    swift_archive="swift-${swift_version}-RELEASE-ubuntu24.04"
    xtool_architecture="x86_64"
    xtool_sha256="dbfd9d7216f077c84c171b688c4173c37c23ca76bf7fd185d1a9ae8a53dab59f"
    ;;
  arm64)
    swift_platform="ubuntu2404-aarch64"
    swift_archive="swift-${swift_version}-RELEASE-ubuntu24.04-aarch64"
    xtool_architecture="aarch64"
    xtool_sha256="4bc0515fed71efb86e82564f358efa0c4c6d76bf1bcfd4c5f256727b53ec59c8"
    ;;
  *)
    echo "The devcontainer Apple toolchain requires amd64 or arm64." >&2
    exit 1
    ;;
esac

installation="/opt/clanky-apple-toolchain"
swift_directory="${installation}/swift-${swift_version}"
xtool_directory="${installation}/xtool-${xtool_version}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "${temporary_directory}"' EXIT

if [[ ! -e "$swift_directory" && ! -L "$swift_directory" ]]; then
  echo "Installing Swift ${swift_version}..."
  swift_url="https://download.swift.org/swift-${swift_version}-release/${swift_platform}/swift-${swift_version}-RELEASE/${swift_archive}.tar.gz"
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 1800 \
    "$swift_url" -o "${temporary_directory}/swift.tar.gz"
  curl --compressed --fail --location --silent --show-error --connect-timeout 15 --max-time 120 \
    "${swift_url}.sig" -o "${temporary_directory}/swift.tar.gz.sig"
  curl --compressed --fail --location --silent --show-error --connect-timeout 15 --max-time 120 \
    https://swift.org/keys/release-key-swift-6.x.asc -o "${temporary_directory}/swift-keys.asc"
  mkdir -m 700 "${temporary_directory}/gnupg"
  fingerprint="$(
    gpg --batch --homedir "${temporary_directory}/gnupg" --with-colons \
      --show-keys "${temporary_directory}/swift-keys.asc" |
      awk -F: '$1 == "fpr" { print $10; exit }'
  )"
  if [[ "$fingerprint" != "52BB7E3DE28A71BE22EC05FFEF80A866B47A981F" ]]; then
    echo "The Swift release signing key has an unexpected fingerprint." >&2
    exit 1
  fi
  gpg --batch --homedir "${temporary_directory}/gnupg" \
    --import "${temporary_directory}/swift-keys.asc"
  gpg --batch --homedir "${temporary_directory}/gnupg" --export "$fingerprint" \
    > "${temporary_directory}/swift-release-key.gpg"
  gpgv --homedir "${temporary_directory}/gnupg" \
    --keyring "${temporary_directory}/swift-release-key.gpg" \
    "${temporary_directory}/swift.tar.gz.sig" "${temporary_directory}/swift.tar.gz"
  mkdir "${temporary_directory}/swift"
  tar -xzf "${temporary_directory}/swift.tar.gz" --strip-components=1 \
    -C "${temporary_directory}/swift"
  sudo install -d "$installation"
  sudo mv "${temporary_directory}/swift" "$swift_directory"
fi
"${swift_directory}/usr/bin/swift" --version | grep -F "Swift version ${swift_version}"

if [[ ! -e "$xtool_directory" && ! -L "$xtool_directory" ]]; then
  echo "Installing xtool ${xtool_version} without FUSE..."
  appimage="${temporary_directory}/xtool.AppImage"
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 \
    "https://github.com/xtool-org/xtool/releases/download/${xtool_version}/xtool-${xtool_architecture}.AppImage" \
    -o "$appimage"
  printf '%s  %s\n' "$xtool_sha256" "$appimage" | sha256sum --check
  chmod +x "$appimage"
  (
    cd "$temporary_directory"
    "$appimage" --appimage-extract > xtool-extract.log
  )
  sudo mv "${temporary_directory}/squashfs-root" "$xtool_directory"
fi
if [[ "$("${xtool_directory}/usr/bin/xtool" --version)" != "xtool ${xtool_version}" ]]; then
  echo "The installed xtool does not match version ${xtool_version}." >&2
  exit 1
fi

link_tool() {
  local source="$1"
  local destination="/usr/local/bin/$(basename "$source")"
  if [[ -e "$destination" || -L "$destination" ]]; then
    if [[ ! -L "$destination" ||
      "$(readlink "$destination")" != "${installation}/"* ]]; then
      echo "Refusing to replace an unrelated tool: ${destination}." >&2
      exit 1
    fi
  fi
  sudo ln -sfn "$source" "$destination"
}

for tool in "${swift_directory}/usr/bin"/swift*; do
  if [[ -x "$tool" && ! -d "$tool" ]]; then
    link_tool "$tool"
  fi
done
link_tool "${swift_directory}/usr/bin/sourcekit-lsp"
link_tool "${xtool_directory}/usr/bin/xtool"

swift --version
xtool --version
xtool sdk status
echo "Apple build tools are installed. Private SDK provisioning is separate from this installer."
