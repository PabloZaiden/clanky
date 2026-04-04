#!/usr/bin/env bash

set -e

# configure bun directories to avoid AccessDenied on temp directory
mkdir -p "$HOME/.bun/tmp"
echo 'export BUN_TMPDIR="$HOME/.bun/tmp"' >> "$HOME/.bashrc"
echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
export BUN_TMPDIR="$HOME/.bun/tmp"
export BUN_INSTALL="$HOME/.bun"

# support executing node scripts
if [ ! -e "/usr/local/bin/node" ]; then
    sudo ln -s /usr/local/bin/bun /usr/local/bin/node
fi

# install sshpass and dtach
sudo apt-get update && sudo apt-get install -y sshpass dtach

# install playwright
bunx playwright install --with-deps --only-shell

# install playwright cli
sudo bun install -g @playwright/cli@latest

