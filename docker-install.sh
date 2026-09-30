#!/bin/bash
# SSDiskDB Docker Installer
# Official endpoint: https://ssdiskdb.js.org/docker-install.sh
#
# Installs Docker + Docker Compose if missing, clones the SSDiskDB source
# repository, builds the image locally, and starts the stack.
#
# Safe to run more than once: it reuses an existing checkout and never deletes
# an existing database directory.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

REPO_URL="https://github.com/manojgowdain/ssdiskdb.git"
INSTALL_DIR="${SSDISKDB_HOME:-$HOME/ssdiskdb}"
DASHBOARD_PORT="8971"

echo -e "${BLUE}====================================================${NC}"
echo -e "${CYAN}         SSDiskDB Docker Installer             ${NC}"
echo -e "${BLUE}====================================================${NC}"
echo -e "Install directory: ${CYAN}${INSTALL_DIR}${NC}"

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

fail() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

# --- Docker --------------------------------------------------------------
if ! command_exists docker; then
    echo -e "${YELLOW}Docker was not found. Attempting to install it...${NC}"
    if command_exists apt-get; then
        sudo apt-get update -y
        sudo apt-get install -y curl ca-certificates gnupg
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
        sudo apt-get update -y
        sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    elif command_exists dnf; then
        sudo dnf config-manager --add-repo=https://download.docker.com/linux/fedora/docker-ce.repo
        sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    elif command_exists brew; then
        brew install --cask docker
    else
        fail "Could not install Docker. Install it manually from https://docker.com/"
    fi
fi

if ! command_exists docker; then
    fail "Docker is still not available after installation. Start the Docker daemon and re-run this script."
fi
echo -e "${GREEN}✓ Docker: $(docker --version)${NC}"

# --- Docker Compose -------------------------------------------------------
if ! docker compose version >/dev/null 2>&1; then
    if command_exists docker-compose; then
        echo -e "${YELLOW}Using legacy 'docker-compose' plugin.${NC}"
        COMPOSE="docker-compose"
    else
        fail "Docker Compose is not available. Install docker-compose-plugin or docker-compose."
    fi
else
    COMPOSE="docker compose"
fi
echo -e "${GREEN}✓ Docker Compose is available${NC}"

# --- Clone / update repository -------------------------------------------
mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

if [ ! -d ".git" ]; then
    echo -e "\n${BLUE}Cloning SSDiskDB repository into ${INSTALL_DIR} ...${NC}"
    git clone "${REPO_URL}" .
else
    echo -e "\n${BLUE}Existing checkout found; pulling latest changes...${NC}"
    git fetch --all
    git reset --hard origin/main
fi

# --- Build and start ------------------------------------------------------
echo -e "\n${BLUE}Building the SSDiskDB Docker image locally (no Docker Hub for SSDiskDB)...${NC}"
${COMPOSE} build --no-panic

echo -e "\n${BLUE}Starting the SSDiskDB stack...${NC}"
${COMPOSE} up -d --build

# --- Wait for health ------------------------------------------------------
echo -e "\n${BLUE}Waiting for the dashboard health endpoint...${NC}"
for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/health" >/dev/null 2>&1; then
        echo -e "${GREEN}✓ SSDiskDB is healthy${NC}"
        break
    fi
    sleep 2
    if [ "$i" -eq 30 ]; then
        echo -e "${YELLOW}Warning: health check did not succeed in time. Check logs with:${NC}"
        echo -e "  ${CYAN}${COMPOSE} logs -f${NC}"
    fi
done

# --- Verify ---------------------------------------------------------------
echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}🎉 SSDiskDB is running in Docker!                   ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Dashboard:   ${CYAN}http://localhost:${DASHBOARD_PORT}${NC}"
echo -e "Logs:        ${CYAN}${COMPOSE} logs -f${NC}"
echo -e "Status:      ${CYAN}${COMPOSE} ps${NC}"
echo -e "Database:    ${CYAN}${INSTALL_DIR}/ssdb-local-db${NC}"
echo -e "\nManagement commands (run inside ${INSTALL_DIR}):"
echo -e "  ${CYAN}${COMPOSE} up -d --build${NC}     - Rebuild and start"
echo -e "  ${CYAN}${COMPOSE} restart${NC}           - Restart (data persists)"
echo -e "  ${CYAN}${COMPOSE} down${NC}              - Stop and remove containers (data persists)"
echo -e "  ${CYAN}${COMPOSE} down -v${NC}           - Stop and remove containers AND data"
echo -e "\nSet admin credentials:"
echo -e "  ${CYAN}cd ${INSTALL_DIR} && docker exec -it ssdiskdb-ssdiskdb-1 node dist/cjs/cli.js credentials --username admin --password secret${NC}"