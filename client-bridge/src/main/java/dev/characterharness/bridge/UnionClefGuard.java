package dev.characterharness.bridge;

import net.fabricmc.loader.api.FabricLoader;

final class UnionClefGuard {
    static boolean ready(){
        try{
            var mod=FabricLoader.getInstance().getModContainer("altoclef");
            if(mod.isEmpty()||!"1.21.11-0.95.63".equals(mod.get().getMetadata().getVersion().getFriendlyString()))return false;
            Class.forName("kaptainwutax.tungsten.TungstenMod").getMethod("stopNavigation");
            Class<?> type=Class.forName("kaptainwutax.tungsten.TungstenConfig");Object config=type.getMethod("get").invoke(null);
            return !type.getField("allowBreak").getBoolean(config)&&!type.getField("allowPlace").getBoolean(config);
        }catch(ReflectiveOperationException|LinkageError e){return false;}
    }
    static void emergencyStop(){
        try{Class.forName("kaptainwutax.tungsten.TungstenMod").getMethod("stopNavigation").invoke(null);}
        catch(ReflectiveOperationException e){throw new IllegalStateException("UnionClef emergency stop unavailable",e);}
    }
}
