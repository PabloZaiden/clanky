#!/usr/bin/env bash

set -e

# install sshpass and dtach
sudo apt-get update && sudo apt-get install -y sshpass dtach

npx -y playwright install-deps
npx -y playwright install
npm install -g @playwright/cli@latest
(cd && playwright-cli install)
