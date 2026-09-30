#!/bin/bash
# SSDiskDB Installer
# Official endpoint: https://ssdiskdb.js.org/install.sh
#
# Installs Node.js (if missing) and installs SSDiskDB globally so the CLI and
# the embedded server/dashboard are available. Safe to run more than once:
# it never deletes an existing database directory.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${CYAN}             SSDiskDB Global Installer              ${NC}"
echo -e "${BLUE}====================================================${NC}"

OS="$(uname -s)"
if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
    echo -e "${RED}Error: This script is only compatible with Linux or macOS.${NC}"
    exit 1
fi

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# --- Node.js -------------------------------------------------------------
if ! command_exists node; then
    echo -e "${YELLOW}Node.js was not found. Attempting to install it...${NC}"
    if command_exists apt-get; then
        echo -e "${BLUE}Detected Debian/Ubuntu. Installing Node.js v20 via nodesource...${NC}"
        sudo apt-get update -y
        sudo apt-get install -y curl ca-certificates gnupg
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
        sudo apt-get update -y
        sudo apt-get install nodejs -y
    elif command_exists dnf; then
        echo -e "${BLUE}Detected RedHat/CentOS/Fedora. Installing Node.js via dnf...${NC}"
        sudo dnf module enable nodejs:20 -y
        sudo dnf install nodejs -y
    elif command_exists yum; then
        echo -e "${BLUE}Detected RedHat/CentOS. Installing Node.js via yum...${NC}"
        curl -sL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install nodejs -y
    elif command_exists brew; then
        echo -e "${BLUE}Detected macOS. Installing Node.js via Homebrew...${NC}"
        brew install node
    else
        echo -e "${RED}Could not locate a supported package manager (apt-get, dnf, yum, or brew).${NC}"
        echo -e "Please install Node.js manually: https://nodejs.org/"
        exit 1
    fi
fi

if ! command_exists node; then
    echo -e "${RED}Failed to install Node.js. Install it manually from https://nodejs.org/.${NC}"
    exit 1
fi

NODE_VERSION="$(node -v)"
echo -e "${GREEN}✓ Node.js is active: ${NODE_VERSION}${NC}"

if ! command_exists npm; then
    echo -e "${RED}Error: npm is missing. Install Node.js from https://nodejs.org/.${NC}"
    exit 1
fi
NPM_VERSION="$(npm -v)"
echo -e "${GREEN}✓ npm is active: ${NPM_VERSION}${NC}"

# --- Install SSDiskDB ----------------------------------------------------
echo -e "\n${BLUE}Installing SSDiskDB globally via npm...${NC}"
sudo npm install -g @manojgowdain/ssdiskdb

# Ensure the binary is reachable on PATH.
if ! command_exists ssdiskdb; then
    echo -e "${YELLOW}Warning: 'ssdiskdb' is not on your current shell PATH.${NC}"
    NPM_BIN_PATH="$(npm config get prefix)"
    if [ -f "${NPM_BIN_PATH}/bin/ssdiskdb" ]; then
        sudo ln -sf "${NPM_BIN_PATH}/bin/ssdiskdb" /usr/local/bin/ssdiskdb
    fi
fi

# --- Verify --------------------------------------------------------------
if command_exists ssdiskdb; then
    echo -e "\n${GREEN}====================================================${NC}"
    echo -e "${GREEN}🎉 SSDiskDB installed successfully!                  ${NC}"
    echo -e "${GREEN}====================================================${NC}"
    echo -e "\nInstalled version:"
    ssdiskdb --version || true
    echo -e "\nNext steps:"
    echo -e "  ${CYAN}ssdiskdb start${NC}             - Start the local cache engine + dashboard"
    echo -e "  ${CYAN}ssdiskdb credentials --username admin --password secret${NC} - Set admin credentials"
    echo -e "  ${CYAN}open http://localhost:8971${NC} - Open the dashboard"
    echo -e "\nDocumentation: https://ssdiskdb.js.org/"
else
    echo -e "${RED}Installation finished, but 'ssdiskdb' could not be resolved.${NC}"
    echo -e "Run it with npx instead:"
    echo -e "  ${YELLOW}npx ssdiskdb start${NC}"
    exit 1
fi