package dev.characterharness.bridge;

import net.fabricmc.loader.api.FabricLoader;

final class UnionClefGuard {
    static boolean ready(){return ready(false);}
    static boolean ready(boolean unrestricted){
        try{
            var mod=FabricLoader.getInstance().getModContainer("altoclef");
            if(mod.isEmpty()||!"1.21.11-0.95.63".equals(mod.get().getMetadata().getVersion().getFriendlyString()))return false;
            Class.forName("kaptainwutax.tungsten.TungstenMod").getMethod("stopNavigation");
            Class.forName("kaptainwutax.tungsten.task.PunkPlayerTask").getMethod("stop");
            Class.forName("kaptainwutax.tungsten.task.RunAwayTask").getMethod("stop");
            Class.forName("kaptainwutax.tungsten.helpers.BlockPlaceHelper").getMethod("clearQueue");
            Class.forName("adris.altoclef.AltoClef").getMethod("stopTasks");
            if(unrestricted)return true;
            Class<?> type=Class.forName("kaptainwutax.tungsten.TungstenConfig");Object config=type.getMethod("get").invoke(null);
            return !type.getField("allowBreak").getBoolean(config)&&!type.getField("allowPlace").getBoolean(config);
        }catch(ReflectiveOperationException|LinkageError e){return false;}
    }
    static void emergencyStopAll(){
        // Runs on the Minecraft thread; remains available when HTTP/core has failed.
        try{
            Class<?> alto=Class.forName("adris.altoclef.AltoClef");
            alto.getMethod("stopTasks").invoke(alto.getMethod("getInstance").invoke(null));
            Class.forName("kaptainwutax.tungsten.task.PunkPlayerTask").getMethod("stop").invoke(null);
            Class.forName("kaptainwutax.tungsten.task.RunAwayTask").getMethod("stop").invoke(null);
            Class.forName("kaptainwutax.tungsten.helpers.BlockPlaceHelper").getMethod("clearQueue").invoke(null);
        }catch(ReflectiveOperationException e){throw new IllegalStateException("UnionClef full stop unavailable",e);}
        finally{emergencyStop();}
    }
    static void emergencyStop(){
        try{Class.forName("kaptainwutax.tungsten.TungstenMod").getMethod("stopNavigation").invoke(null);}
        catch(ReflectiveOperationException e){throw new IllegalStateException("UnionClef emergency stop unavailable",e);}
    }
}
