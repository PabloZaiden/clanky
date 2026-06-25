#!/usr/bin/env bash

set -e

# install sshpass and dtach
sudo apt-get update && sudo apt-get install -y sshpass dtach

npx playwright install-deps
npx playwright install
npm install -g @playwright/cli@latest
(cd && playwright-cli install)
