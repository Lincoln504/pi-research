# Sourced (hidden) at the top of every VHS demo so the recorded shell matches
# the real alacritty/bash look. Keeping escapes in a real file avoids VHS
# Type-string escaping pitfalls.

# Green Debian-style prompt, generic identity (no real user@host) for public GIFs.
export PS1='\[\033[01;32m\][ you@pi:\W$ ]\[\033[00m\] '

# Clean command name in the recording instead of `node .../dist/cli.mjs`.
pi-research() { node /home/ldeen/Documents/pi-research/dist/cli.mjs "$@"; }

# Start from the repo root so the prompt reads `pi-research` and `pi` loads the
# extension from here.
cd /home/ldeen/Documents/pi-research 2>/dev/null

# Hide the text caret for a cursor-free recording (comment out to keep it).
# tput civis 2>/dev/null

clear
