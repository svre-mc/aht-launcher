
### 0.2.30 repair 1

The launcher remains labeled v0.2.30. Its internal update identifier is
0.2.30-repair.1 so the original 0.2.30 installations receive this required repair.

- Update the Windows installer toolset to the pinned NSIS 3.12 release and store
  the standalone uninstaller without compression for direct inspection.
- Preserve the default-checked modpack and game-data removal option, keep/cancel
  choices, silent upgrade preservation, and junction protections.
- Deliver the repaired uninstaller through the normal ZIP update and preserve
  the exact repair identity used by existing Windows updater validation.
- Support publication of the exact reviewed build artifacts, with source-commit
  and installer/update/application/uninstaller SHA256 checks before publication.

Game content, Phoenix, account authorization, and integrity requirements are unchanged.
