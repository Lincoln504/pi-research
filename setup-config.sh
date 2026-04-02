#!/bin/bash
# pi-research Configuration Setup
# Interactive setup script for easy TOR toggle

CONFIG_FILE="$(dirname "$0")/.env"
EXAMPLE_FILE="$(dirname "$0")/.env.example"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "🔧 pi-research Configuration Setup"
echo "=================================="
echo ""

# Check if .env exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}No .env file found. Creating from .env.example...${NC}"
    if [ -f "$EXAMPLE_FILE" ]; then
        cp "$EXAMPLE_FILE" "$CONFIG_FILE"
        echo -e "${GREEN}✓ Created .env file${NC}"
    else
        echo -e "${RED}Error: .env.example not found${NC}"
        exit 1
    fi
fi

echo ""
echo "Current Configuration:"
echo "----------------------------------------"
if [ -f "$CONFIG_FILE" ]; then
    grep "PI_RESEARCH_ENABLE_TOR" "$CONFIG_FILE" || echo "PI_RESEARCH_ENABLE_TOR not set"
    grep "PI_RESEARCH_TOR_SOCKS_PORT" "$CONFIG_FILE" || echo "PI_RESEARCH_TOR_SOCKS_PORT not set"
    grep "PI_RESEARCH_TOR_AUTO_START" "$CONFIG_FILE" || echo "PI_RESEARCH_TOR_AUTO_START not set"
fi
echo "----------------------------------------"
echo ""

echo "What would you like to configure?"
echo "1) Toggle Tor (enable/disable)"
echo "2) Set Tor port"
echo "3) Enable/disable Tor auto-start"
echo "4) Show full .env file"
echo "5) Edit .env file directly"
echo ""
read -p "Select option [1-5]: " choice

case $choice in
    1)
        read -p "Enable Tor? [y/n]: " enable
        if [ "$enable" = "y" ] || [ "$enable" = "Y" ]; then
            sed -i 's/^PI_RESEARCH_ENABLE_TOR=.*/PI_RESEARCH_ENABLE_TOR=true/' "$CONFIG_FILE"
            echo -e "${GREEN}✓ Tor enabled${NC}"
        else
            sed -i 's/^PI_RESEARCH_ENABLE_TOR=.*/PI_RESEARCH_ENABLE_TOR=false/' "$CONFIG_FILE"
            echo -e "${GREEN}✓ Tor disabled${NC}"
        fi
        ;;
    2)
        read -p "Enter Tor SOCKS port [default: 9050]: " port
        if [ -z "$port" ]; then
            port=9050
        fi
        sed -i "s/^PI_RESEARCH_TOR_SOCKS_PORT=.*/PI_RESEARCH_TOR_SOCKS_PORT=$port/" "$CONFIG_FILE"
        echo -e "${GREEN}✓ Tor port set to $port${NC}"
        ;;
    3)
        read -p "Enable Tor auto-start? [y/n]: " autostart
        if [ "$autostart" = "y" ] || [ "$autostart" = "Y" ]; then
            sed -i 's/^PI_RESEARCH_TOR_AUTO_START=.*/PI_RESEARCH_TOR_AUTO_START=true/' "$CONFIG_FILE"
            echo -e "${GREEN}✓ Tor auto-start enabled${NC}"
        else
            sed -i 's/^PI_RESEARCH_TOR_AUTO_START=.*/PI_RESEARCH_TOR_AUTO_START=false/' "$CONFIG_FILE"
            echo -e "${GREEN}✓ Tor auto-start disabled${NC}"
        fi
        ;;
    4)
        echo ""
        cat "$CONFIG_FILE"
        ;;
    5)
        echo ""
        echo "Opening .env file for editing..."
        ${EDITOR:-nano} "$CONFIG_FILE"
        ;;
    *)
        echo -e "${RED}Invalid option${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✓ Configuration updated!${NC}"
echo ""
echo "To apply changes:"
echo "  1. Source the .env file: ${YELLOW}source .env${NC}"
echo "  2. Or add to your ~/.bashrc: ${YELLOW}echo 'source ~/Documents/pi-research/.env' >> ~/.bashrc${NC}"
echo "  3. Then run: ${YELLOW}pi${NC}"
