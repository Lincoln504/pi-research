Output out/06-hero-clip.gif
# 160:100 aspect ratio for the static hero screenshot.
Set Width 1600
Set Height 1000
Set Framerate 12
Source lib/look.tape

Hide
Type "source /home/ldeen/Documents/pi-research/demo/lib/hero-env.sh"
Enter
Type "clear"
Enter
Show
Sleep 300ms

Type "pi"
Enter
Sleep 5s

# Two distinct subtopics -> two simultaneous researchers (capped at 2).
Type "/research current news, and the latest small 1B-parameter LLMs"
Sleep 800ms
Enter

# Let both researchers spin up, then grab the static hero frame.
Sleep 16s
Screenshot out/hero.png
Sleep 800ms

Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 500ms
