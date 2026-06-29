# Shared look + shell setup. Source this AFTER a tape sets its own Output and
# Width/Height (those are the only per-demo Set values). All Set commands must
# precede any typed command, which is why the prompt/alias setup lives at the
# end here behind Hide/Show.

Set Shell "bash"
Set FontFamily "Fira Code"
Set FontSize 20
Set Padding 10
Set Margin 0
Set TypingSpeed 55ms
Set Theme { "name": "alacritty-default", "background": "#1d1f21", "foreground": "#c5c8c6", "selection": "#373b41", "cursor": "#c5c8c6", "black": "#1d1f21", "red": "#cc6666", "green": "#b5bd68", "yellow": "#f0c674", "blue": "#81a2be", "magenta": "#b294bb", "cyan": "#8abeb7", "white": "#c5c8c6", "brightBlack": "#666666", "brightRed": "#d54e53", "brightGreen": "#b9ca4a", "brightYellow": "#e7c547", "brightBlue": "#7aa6da", "brightMagenta": "#c397d8", "brightCyan": "#70c0b1", "brightWhite": "#eaeaea" }

Hide
Type "source /home/ldeen/Documents/pi-research/demo/lib/demo.bashrc"
Enter
Sleep 300ms
Show
