package com.aht.launcherlock.core;

import java.util.Map;
import net.minecraftforge.fml.relauncher.IFMLLoadingPlugin;

@IFMLLoadingPlugin.Name("AHT pre-world admission")
@IFMLLoadingPlugin.MCVersion("1.12.2")
@IFMLLoadingPlugin.SortingIndex(1001)
@IFMLLoadingPlugin.TransformerExclusions({"com.aht.launcherlock.core"})
public final class AdmissionPlugin implements IFMLLoadingPlugin {
    public String[] getASMTransformerClass() { return new String[]{AdmissionTransformer.class.getName()}; }
    public String getModContainerClass() { return null; }
    public String getSetupClass() { return null; }
    public void injectData(Map<String,Object> data) { }
    public String getAccessTransformerClass() { return null; }
}
