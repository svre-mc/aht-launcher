# AHT Version Lock

Forge 1.12.2 helper mod for private A Hard Time servers.

Install the built jar on both the client pack and the server. The launcher writes the client pack version to:

```text
.aht-launcher/installed.json
```

When a player connects, the client sends that installed `packId` and `version` to the server. The server compares it to `config/aht_version_lock.cfg` and disconnects players whose version is missing, outdated, or from the wrong pack.

Build with Java 8:

```powershell
cd server-lock-mod
gradle build
```

The release builder also writes a server config template to:

```text
server/aht_version_lock.cfg
```

Copy that file into the Minecraft server `config/` folder when publishing a new required pack version.

The Gradle project compiles against Forge `1.12.2-14.23.5.2847` because that userdev artifact is available in the local ForgeGradle cache. The built mod only uses stable 1.12.2 Forge networking/events and is intended for Forge 1.12.2 packs, including the 14.23.5.2860 runtime used by the pack.
