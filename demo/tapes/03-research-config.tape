Output out/03-research-config.gif
Set Width 1280
Set Height 860
Set Framerate 12
Source lib/look.tape

Sleep 600ms
Type "pi"
Enter
Sleep 5s

Type "/research-config"
Sleep 600ms
Enter
Sleep 2s

# Arrow-key navigation through the settings list (the part to prove out).
Down@550ms 4
Sleep 800ms
Up@550ms 2
Sleep 800ms

# Cycle the highlighted setting's value with Enter, then move on.
Enter
Sleep 1.2s
Down@550ms 1
Enter
Sleep 1.2s

# Close the menu, then exit pi.
Escape
Sleep 1s
Ctrl+C
Sleep 600ms
Ctrl+C
Sleep 800ms
