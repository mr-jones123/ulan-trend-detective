# 30-second terminal demo, recorded with VHS by Claude Code (Claude Opus 5.5).
# Run from the repo root: vhs demo/demo.tape && demo/watermark.sh
Output demo/raw.mp4

Set Shell bash
Set FontSize 17
Set Width 1280
Set Height 720
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful

Hide
Type "export PS1='$ ' PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH && clear"
Enter
Sleep 500ms
Show

Type "python3 demo/highlights.py"
Sleep 300ms
Enter
Sleep 15s

Type "bun test 2>&1 | grep -E 'pass|fail|Ran'"
Sleep 300ms
Enter
Sleep 12500ms
