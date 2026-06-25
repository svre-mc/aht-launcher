package com.aht.launcherlock;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraftforge.fml.common.Loader;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;

public final class InstalledVersionReader {
    private InstalledVersionReader() {
    }

    public static PackVersionMessage readInstalledVersion() {
        File configDir = Loader.instance().getConfigDir();
        File gameDir = configDir == null ? new File(".") : configDir.getParentFile();
        File installedJson = new File(new File(gameDir, ".aht-launcher"), "installed.json");
        if (!installedJson.isFile()) {
            return new PackVersionMessage("", "", false);
        }

        try (Reader reader = new InputStreamReader(new FileInputStream(installedJson), StandardCharsets.UTF_8)) {
            JsonObject json = new JsonParser().parse(reader).getAsJsonObject();
            return new PackVersionMessage(readString(json, "packId"), readString(json, "version"), true);
        } catch (Exception error) {
            PackVersionLock.LOG.warn("Could not read launcher installed.json", error);
            return new PackVersionMessage("", "", false);
        }
    }

    private static String readString(JsonObject json, String key) {
        return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : "";
    }
}
