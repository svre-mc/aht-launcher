AHT Launcher 0.2.09 combines the launcher startup, update, and runtime protection work.

- Warm launches reuse validated runtime paths; first initialization, Update and Repair retain full validation.
- CurseForge and Minecraft metadata are preserved during ordinary Play.
- A compact update popup appears while the launcher is open, reports actual progress, and offers Restart only after verification and staging.
- Windows updates use a prepared atomic swap with recovery if the replacement cannot start. macOS and Linux retain their platform update paths.
- Windows adds a separate read-only game runtime guard and disables the standard Java attach mechanism. Fresh signed measurements support server checks for repeated protected native-code changes.
- Developer launcher startup and local update paths retain their separate behavior.

The Windows helper includes a notice describing its scope and data. This is user-mode protection, not a guarantee against every injector. Server-authoritative movement and packet enforcement remains part of the paired anti-cheat rollout.
