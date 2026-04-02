#!/bin/bash
# pi-research Configuration Setup
# Interactive setup script for easy proxy configuration

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
echo "Current Proxy Configuration:"
echo "----------------------------------------"
if [ -f "$CONFIG_FILE" ]; then
    grep "PROXY_URL" "$CONFIG_FILE" || echo "PROXY_URL not set (using direct connection)"
fi
echo "----------------------------------------"
echo ""

echo "What would you like to configure?"
echo "1) Set proxy URL (Tor or HTTP proxy)"
echo "2) Clear proxy URL (use direct connection)"
echo "3) Show full .env file"
echo "4) Edit .env file directly"
echo ""
read -p "Select option [1-4]: " choice

case $choice in
    1)
        echo ""
        echo "Enter your proxy URL:"
        echo "  - For Tor:            socks5://127.0.0.1:9050"
        echo "  - For Tor Browser:     socks5://127.0.0.1:9150"
        echo "  - For HTTP proxy:     http://proxy.example.com:8080"
        echo "  - For authenticated:  http://user:pass@proxy.example.com:8080"
        echo ""
        read -p "Proxy URL: " proxy_url

        if [ -n "$proxy_url" ]; then
            sed -i "s|^PROXY_URL=.*|PROXY_URL=$proxy_url|" "$CONFIG_FILE"
            echo -e "${GREEN}✓ Proxy URL set to: $proxy_url${NC}"
            echo ""
            echo "Make sure your proxy is running before starting pi!"
        else
            echo -e "${RED}✗ Proxy URL cannot be empty${NC}"
            exit 1
        fi
        ;;
    2)
        sed -i 's/^PROXY_URL=.*/PROXY_URL=/' "$CONFIG_FILE"
        echo -e "${GREEN}✓ Proxy URL cleared (using direct connection)${NC}"
        ;;
    3)
        echo ""
        cat "$CONFIG_FILE"
        ;;
    4)
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
echo "  1. Source .env file: ${YELLOW}source .env${NC}"
echo "  2. Or add to your ~/.bashrc: ${YELLOW}echo 'source ~/Documents/pi-research/.env' >> ~/.bashrc${NC}"
echo "  3. Then run: ${YELLOW}pi${NC}"
