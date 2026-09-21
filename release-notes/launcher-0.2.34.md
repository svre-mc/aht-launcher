# Launcher 0.2.34

- Reuse the existing Minecraft login with either CurseForge launch setting: the Mojang launcher or CurseForge's direct launcher.
- Validate and renew saved CurseForge Minecraft sessions automatically, without opening a second sign-in flow.
- Let Repair restore game files, Java, Forge, assets, native libraries and Phoenix without requiring account selection.
- Fix direct Minecraft window visibility and native library loading on Windows.
- Retain permission recovery with Allow/Cancel and Windows elevation when required, plus bounded network Retry/Cancel.

Protected file verification, Phoenix and authenticated server admission remain required. If Microsoft actually rejects a saved session, the launcher reports that specific account problem.
