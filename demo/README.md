# demo/ — terminal demo GIF pipeline

Scripted, headless terminal recordings rendered to optimized GIFs with
[charmbracelet/vhs](https://github.com/charmbracelet/vhs). Every demo is a
declarative `.tape` file — no hand-typing, no focus-stealing, fully repeatable.

This tooling is dev-only; it is not shipped in the npm package.

## Why VHS (not xdotool/ffmpeg/Xvfb)

VHS runs its own headless terminal (ttyd) and renders frames with a browser +
ffmpeg. That means:

- Keystrokes — including arrows (`Up`/`Down`/`Left`/`Right`), `Enter`, `Ctrl+C`
  and evenly-timed `Type` — are scripted and exact.
- It never grabs the real keyboard, so it runs unattended while you keep working.
- No Xvfb / OpenGL / window-geometry wrangling.

The one tradeoff: VHS uses its own renderer, so the output is *styled to match*
alacritty rather than being literal alacritty pixels. `lib/look.tape` +
`lib/demo.bashrc` reproduce the look: Fira Code 20, padding 10, alacritty's
default palette, and the real bash prompt.

## Requirements

- `vhs` and `ttyd` on `PATH` (installed to `~/.local/bin`):
  ```
  curl -sL https://github.com/charmbracelet/vhs/releases/download/v0.11.0/vhs_0.11.0_Linux_x86_64.tar.gz | tar -xz -C /tmp && cp /tmp/vhs_*/vhs ~/.local/bin/
  curl -sL -o ~/.local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x ~/.local/bin/ttyd
  ```
- `ffmpeg` and a chromium/chrome (already present on this machine).
- `gifsicle` for optimization (`sudo apt install gifsicle`).

## Layout

```
demo/
  build.sh                 render all (or selected) tapes -> out/*.gif -> gifsicle
  lib/
    look.tape              shared Set block (font/theme/padding) + prompt setup
    demo.bashrc            green prompt + pi-research alias, sourced hidden
    mock-env.sh            PI_RESEARCH_MOCK_* env for the live-panel demo
  themes/
    alacritty-default.json reference copy of the palette inlined in look.tape
  tapes/
    01-cli-help.tape       pi-research help          (no network, no key)
    02-cli-status.tape     pi-research status        (no network, no key)
    03-research-config.tape /research-config TUI, arrow-key navigation (no key)
    04-research-panel.tape  live research panel + waves (mock network; needs key)
  out/                     generated GIFs
```

## Usage

```
./build.sh            # render every tape
./build.sh 01 03      # only tapes starting 01 / 03
```

Each tape declares its own `Output` and window size, then `Source lib/look.tape`
for the shared style. `build.sh` renders then runs
`gifsicle -O3 --lossy=60 --colors 200` on each result.

## Authoring notes

- **Per-key timing**: `Set TypingSpeed 55ms`, or override one line with
  `Type@30ms "..."`.
- **Special keys / repeats**: `Down@550ms 4` presses Down four times, 550 ms
  apart. Same for `Up`, `Left`, `Right`, `Tab`, `Enter`, `Ctrl+C`.
- **Sync to output**: `Set WaitTimeout 180s` then `Wait+Screen /CITED LINKS/`
  pauses until that regex appears — better than guessing a `Sleep` for runs of
  variable length.
- **Cursor-free**: there is no mouse pointer in VHS output. To also hide the
  text caret, uncomment `tput civis` in `lib/demo.bashrc`.
- **Wave animation**: the panel wave runs ~30 fps; bump `Set Framerate` (in
  `look.tape` or per-tape) to 24-30 for the `04` demo if it looks choppy, at the
  cost of GIF size.
- **Privacy**: `demo.bashrc` shows the real `\u@\h` (`ldeen@debian`). Swap the
  `PS1` line for a generic `you@pi` before publishing a GIF to a public README.

## Paths

`lib/look.tape`, `lib/demo.bashrc`, and `lib/mock-env.sh` reference the absolute
repo path `/home/ldeen/Documents/pi-research`. Update those three if the repo
moves.
