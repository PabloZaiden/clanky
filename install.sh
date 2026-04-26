#!/bin/sh
set -e

# Ralpher installer script
# Usage: curl -fsSL https://raw.githubusercontent.com/pablozaiden/ralpher/main/install.sh | sh

REPO="pablozaiden/ralpher"
INSTALL_DIR="$HOME/.local/bin"
SERVER_BINARY_NAME="ralpher"
CLI_BINARY_NAME="ralpher-cli"

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)       echo "unsupported" ;;
  esac
}

# Detect architecture
detect_arch() {
  case "$(uname -m)" in
    x86_64)  echo "x64" ;;
    amd64)   echo "x64" ;;
    aarch64) echo "arm64" ;;
    arm64)   echo "arm64" ;;
    *)       echo "unsupported" ;;
  esac
}

OS=$(detect_os)
ARCH=$(detect_arch)

if [ "$OS" = "unsupported" ]; then
  echo "Error: Unsupported operating system: $(uname -s)"
  echo "Ralpher supports Linux and macOS only."
  exit 1
fi

if [ "$ARCH" = "unsupported" ]; then
  echo "Error: Unsupported architecture: $(uname -m)"
  echo "Ralpher supports x64 and arm64 architectures only."
  exit 1
fi

echo "Detected platform: $OS-$ARCH"

# Get latest release tag
echo "Fetching latest release..."
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  echo "Error: Could not determine latest release version."
  exit 1
fi

echo "Latest version: $LATEST_TAG"

# Create install directory if needed
mkdir -p "$INSTALL_DIR"

install_binary() {
  ASSET_PREFIX="$1"
  BINARY_NAME="$2"
  ASSET_NAME="$ASSET_PREFIX-$LATEST_TAG-$OS-$ARCH"
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET_NAME"
  TEMP_FILE=$(mktemp)

  echo "Downloading $ASSET_NAME..."
  if ! curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_FILE"; then
    echo "Error: Failed to download from $DOWNLOAD_URL"
    rm -f "$TEMP_FILE"
    exit 1
  fi

  mv "$TEMP_FILE" "$INSTALL_DIR/$BINARY_NAME"
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  echo "Installed $BINARY_NAME to $INSTALL_DIR/$BINARY_NAME"
}

install_binary "ralpher" "$SERVER_BINARY_NAME"
install_binary "ralpher-cli" "$CLI_BINARY_NAME"

# Check if install directory is in PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo ""
    echo "Installation complete!"
    echo "  Run 'ralpher' to start the local server."
    echo "  Run 'ralpher-cli --help' to use the API client."
    ;;
  *)
    echo ""
    echo "Warning: $INSTALL_DIR is not in your PATH."
    echo ""
    echo "Add it to your shell profile:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Or run directly with:"
    echo "  $INSTALL_DIR/$SERVER_BINARY_NAME"
    echo "  $INSTALL_DIR/$CLI_BINARY_NAME"
    ;;
esac
