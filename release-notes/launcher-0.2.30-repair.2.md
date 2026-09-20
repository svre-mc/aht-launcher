# AHT Launcher v0.2.30 installer repair

Fixes Windows fresh installation failing with “Failed to decompress files” and garbled error text. The installer now uses the verified Unicode ZIP plugin with the Unicode NSIS compiler.

The launcher still displays v0.2.30. The internal repair identity advances to 0.2.30-repair.2 so existing installations receive the required patch. Launcher features, Phoenix checks, modpacks, and the default-checked uninstall data-removal choice are preserved.

Release validation now runs the actual Windows EXE installer on a disposable machine, compares its installed files with the update ZIP, opens the installed launcher, and checks silent uninstallation before artifacts can be published.
