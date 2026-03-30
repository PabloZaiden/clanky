#!/usr/bin/env bash

set -e

# install sshpass and dtach
sudo apt-get update && sudo apt-get install -y sshpass dtach

bunx playwright install --with-deps --only-shell