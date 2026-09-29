#!/bin/bash

# SSDiskDB Installer Script
# Installs Node.js (if missing) and installs ssdiskdb globally to grant CLI and server capability.

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================${NC}"
echo -e "${CYAN}             SSDiskDB Global Installer              ${NC}"
echo -e "${BLUE}====================================================${NC}"

# Check OS compatibility
OS="$(uname -s)"
if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
    echo -e "${RED}Error: This script is only compatible with Linux or macOS.${NC}"
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check Node.js and NPM dependencies
if ! command_exists node; then
    echo -e "${YELLOW}Warning: Node.js was not found on your system.${NC}"
    echo -e "Attempting to install Node.js using your system package manager..."

    if command_exists apt-get; then
        echo -e "${BLUE}Detected Debian/Ubuntu system. Installing Node.js v20 via nodesource...${NC}"
        sudo apt-get update -y
        sudo apt-get install -y curl ca-certificates gnupg
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
        sudo apt-get update -y
        sudo apt-get install nodejs -y
    elif command_exists dnf; then
        echo -e "${BLUE}Detected RedHat/CentOS/Fedora system. Installing Node.js via dnf...${NC}"
        sudo dnf module enable nodejs:20 -y
        sudo dnf install nodejs -y
    elif command_exists yum; then
        echo -e "${BLUE}Detected RedHat/CentOS system. Installing Node.js via yum...${NC}"
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

# Re-check Node.js installation
if ! command_exists node; then
    echo -e "${RED}Failed to install Node.js. Please install it manually before running this script.${NC}"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}✓ Node.js is active: $NODE_VERSION${NC}"

# Check and install NPM if missing (usually bundled with Node.js)
if ! command_exists npm; then
    echo -e "${RED}Error: NPM is missing. Please make sure NPM is installed alongside Node.js.${NC}"
    exit 1
fi
NPM_VERSION=$(npm -v)
echo -e "${GREEN}✓ NPM is active: $NPM_VERSION${NC}"

echo -e "\n${BLUE}Installing SSDiskDB globally via NPM...${NC}"
sudo npm install -g ssdiskdb

# Post-install symlink check to ensure executable is in PATH
if ! command_exists ssdiskdb; then
    echo -e "${YELLOW}Warning: 'ssdiskdb' is not directly reachable in your current shell PATH.${NC}"
    echo -e "Creating a soft link in '/usr/local/bin'..."
    NPM_BIN_PATH=$(npm config get prefix)
    if [ -f "$NPM_BIN_PATH/bin/ssdiskdb" ]; then
        sudo ln -sf "$NPM_BIN_PATH/bin/ssdiskdb" /usr/local/bin/ssdiskdb
    else
        # Find global binary path fallback
        FALLBACK_BIN=$(which ssdiskdb 2>/dev/null)
        if [ -n "$FALLBACK_BIN" ]; then
            sudo ln -sf "$FALLBACK_BIN" /usr/local/bin/ssdiskdb
        fi
    fi
fi

# Final Verification
if command_exists ssdiskdb; then
    echo -e "\n${GREEN}====================================================${NC}"
    echo -e "${GREEN}🎉 Success: SSDiskDB has been installed globally!   ${NC}"
    echo -e "${GREEN}====================================================${NC}"
    echo -e "\nYou can now use the following CLI commands:\n"
    echo -e "  ${CYAN}ssdiskdb start${NC}             - Start the local cache engine and dashboard (port 8971)"
    echo -e "  ${CYAN}ssdiskdb start --port 9000${NC} - Start on custom port"
    echo -e "  ${CYAN}ssdiskdb credentials${NC}       - Set admin username and password"
    echo -e "  ${CYAN}ssdiskdb server add <id>${NC}   - Register and whitelist a remote client"
    echo -e "\nDocumentation: ${BLUE}https://github.com/manojgowdain/ssdiskdb#readme${NC}\n"
else
    echo -e "${RED}Installation finished, but 'ssdiskdb' command could not be resolved.${NC}"
    echo -e "Please verify your global NPM PATH settings or run manually using:"
    echo -e "  ${YELLOW}npx ssdiskdb start${NC}"
fi
