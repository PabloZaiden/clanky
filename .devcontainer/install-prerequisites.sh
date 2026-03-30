#!/usr/bin/env bash

set -e

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

