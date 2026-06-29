# Sourced (hidden) before launching pi for the live-panel demo. Renders the full
# research TUI (waves, researcher columns, tokens, progress, CITED LINKS) WITHOUT
# hitting the network. The LLM call itself is still real, so a configured model
# key is required (see `pi-research status`).
export PI_RESEARCH_MOCK_SEARCH=true
export PI_RESEARCH_MOCK_SCRAPE=true
export PI_RESEARCH_FORCE_READY=true
export PI_RESEARCH_KNOWLEDGE_STORE_MODE=none
