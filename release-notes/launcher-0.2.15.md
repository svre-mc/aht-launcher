
### Startup and Play fixes

- Fixed updated installations being checked against an older release's file list.
- Reuse prepared Minecraft and Java paths when the runtime has not changed.
- Verify changed client files without rehashing unchanged protected files.
- Removed an unnecessary startup animation-frame wait.
- Fixed Windows incorrectly reporting that Minecraft Launcher failed to open.
- Kept protected-file verification, Phoenix, and launch authorization enabled.

Includes the Windows installer and updater, one universal macOS download for Intel
and Apple Silicon, and the portable Linux x64 download and updater.
