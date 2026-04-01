#!/bin/bash
# Setup script for pi-research extension symlinks
# Toggles between pi-research only and pi-research + pi-search-scrape

EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
PI_RESEARCH_SYMLINK="$EXTENSIONS_DIR/pi-research"
PI_SEARCH_SCRAPE_SYMLINK="$EXTENSIONS_DIR/pi-search-scrape"

PI_RESEARCH_DIR="$HOME/Documents/pi-research"
PI_SEARCH_SCRAPE_DIR="$HOME/Documents/pi-search-scrape"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔧 pi-research Extension Setup"
echo "================================"

# Ensure pi-research symlink exists
if [ ! -L "$PI_RESEARCH_SYMLINK" ]; then
    echo -e "${GREEN}Creating symlink for pi-research...${NC}"
    ln -s "$PI_RESEARCH_DIR" "$PI_RESEARCH_SYMLINK"
else
    # Verify it points to correct location
    CURRENT_TARGET=$(readlink -f "$PI_RESEARCH_SYMLINK")
    if [ "$CURRENT_TARGET" != "$PI_RESEARCH_DIR" ]; then
        echo -e "${YELLOW}Updating pi-research symlink...${NC}"
        rm "$PI_RESEARCH_SYMLINK"
        ln -s "$PI_RESEARCH_DIR" "$PI_RESEARCH_SYMLINK"
    else
        echo -e "${GREEN}✓ pi-research symlink already exists${NC}"
    fi
fi

# Menu for pi-search-scrape
echo ""
echo "pi-search-scrape configuration:"
echo "1) Disable (pi-research standalone)"
echo "2) Enable  (pi-research + pi-search-scrape)"
echo ""
read -p "Select option [1-2]: " choice

case $choice in
    1)
        # Disable pi-search-scrape
        if [ -L "$PI_SEARCH_SCRAPE_SYMLINK" ]; then
            echo -e "${RED}Removing pi-search-scrape symlink...${NC}"
            rm "$PI_SEARCH_SCRAPE_SYMLINK"
        else
            echo -e "${GREEN}✓ pi-search-scrape already disabled${NC}"
        fi
        echo ""
        echo -e "${GREEN}Configuration: pi-research standalone mode${NC}"
        echo "SEARXNG_EXTERNAL_MANAGED will be set by pi-research"
        ;;
    2)
        # Enable pi-search-scrape
        if [ ! -L "$PI_SEARCH_SCRAPE_SYMLINK" ]; then
            echo -e "${GREEN}Creating symlink for pi-search-scrape...${NC}"
            ln -s "$PI_SEARCH_SCRAPE_DIR" "$PI_SEARCH_SCRAPE_SYMLINK"
        else
            # Verify it points to correct location
            CURRENT_TARGET=$(readlink -f "$PI_SEARCH_SCRAPE_SYMLINK")
            if [ "$CURRENT_TARGET" != "$PI_SEARCH_SCRAPE_DIR" ]; then
                echo -e "${YELLOW}Updating pi-search-scrape symlink...${NC}"
                rm "$PI_SEARCH_SCRAPE_SYMLINK"
                ln -s "$PI_SEARCH_SCRAPE_DIR" "$PI_SEARCH_SCRAPE_SYMLINK"
            else
                echo -e "${GREEN}✓ pi-search-scrape symlink already exists${NC}"
            fi
        fi
        echo ""
        echo -e "${GREEN}Configuration: pi-research + pi-search-scrape${NC}"
        echo "pi-search-scrape will manage its own SearXNG instance"
        ;;
    *)
        echo -e "${RED}Invalid option${NC}"
        exit 1
        ;;
esac

echo ""
echo "Current symlinks:"
echo "----------------------------------------"
ls -l "$EXTENSIONS_DIR" | grep -E "(pi-research|pi-search-scrape)" || echo "No matching symlinks found"
echo "----------------------------------------"
echo ""
echo -e "${GREEN}✓ Setup complete!${NC}"
echo ""
echo "To test pi-research:"
echo "  1. Start pi: ${YELLOW}pi${NC}"
echo "  2. Use research tool: ${YELLOW}research('your query')${NC}"
