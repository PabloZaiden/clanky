#!/usr/bin/env bash

set -e

# install sshpass and dtach
sudo apt-get update && sudo apt-get install -y sshpass dtach

# install playwright dependencies
sudo apt-get install -y\
    libglib2.0-0t64\
    libnspr4\
    libnss3\
    libatk1.0-0t64\
    libatk-bridge2.0-0t64\
    libdbus-1-3\
    libcups2t64\
    libxcb1\
    libxkbcommon0\
    libasound2t64\
    libgbm1\
    libx11-6\
    libxext6\
    libcairo2\
    libpango-1.0-0\
    libxcomposite1\
    libxdamage1\
    libxfixes3\
    libxrandr2\
    libatspi2.0-0t64

# DISABLED FOR NOW. THERE IS A BUG THAT INSTALLING 
# THE BROWSER WITH THE CLI CAUSES THE INSTALLATION TO HANG.

# install playwright cli
#npm install -g @playwright/cli@latest

# install playwright chrome
#(cd && playwright-cli install)
