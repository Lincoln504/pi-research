Output out/05-hero-square.gif
# Square, bare terminal (no charm window chrome) for the pi.dev catalog image.
Set Width 1080
Set Height 1080
Set Framerate 24
Source lib/look.tape

# Mock network so the live panel renders offline (LLM call is real).
Hide
Type "source /home/ldeen/Documents/pi-research/demo/lib/mock-env.sh"
Enter
Type "clear"
Enter
Show
Sleep 300ms

# Launch straight into pi — the demo lives inside the pi TUI.
Type "pi"
Enter
Sleep 5s

# Drive the research from INSIDE the pi TUI via the /research slash command
# (deterministic: calls researchTool.execute at DEFAULT_RESEARCH_DEPTH).
Type "/research the latest developments in WebAssembly"
Sleep 800ms
Enter

# Hold on the live research panel (waves, columns, tokens), then abort.
Sleep 26s

Ctrl+C
Sleep 600ms
Ctrl+C
Sleep 600ms
