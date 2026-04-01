#!/bin/bash
# Quick toggle for pi-search-scrape symlink
# Run without arguments to toggle, or pass "on" or "off"

EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
PI_SEARCH_SCRAPE_SYMLINK="$EXTENSIONS_DIR/pi-search-scrape"
PI_SEARCH_SCRAPE_DIR="$HOME/Documents/pi-search-scrape"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Argument or toggle
if [ "$1" = "on" ]; then
    action="enable"
elif [ "$1" = "off" ]; then
    action="disable"
else
    # Toggle current state
    if [ -L "$PI_SEARCH_SCRAPE_SYMLINK" ]; then
        action="disable"
    else
        action="enable"
    fi
fi

case $action in
    enable)
        if [ ! -L "$PI_SEARCH_SCRAPE_SYMLINK" ]; then
            echo -e "${GREEN}➤ Enabling pi-search-scrape...${NC}"
            ln -s "$PI_SEARCH_SCRAPE_DIR" "$PI_SEARCH_SCRAPE_SYMLINK"
        else
            echo -e "${GREEN}✓ pi-search-scrape already enabled${NC}"
        fi
        ;;
    disable)
        if [ -L "$PI_SEARCH_SCRAPE_SYMLINK" ]; then
            echo -e "${RED}✖ Disabling pi-search-scrape...${NC}"
            rm "$PI_SEARCH_SCRAPE_SYMLINK"
        else
            echo -e "${GREEN}✓ pi-search-scrape already disabled${NC}"
        fi
        ;;
esac

echo ""
echo "Current state:"
ls -l "$EXTENSIONS_DIR" | grep -E "(pi-research|pi-search-scrape)" | awk '{printf "  %-30s %s\n", $9, $11}'
