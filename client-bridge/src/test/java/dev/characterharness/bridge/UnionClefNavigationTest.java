package dev.characterharness.bridge;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class UnionClefNavigationTest {
    @Test void cancelWhileGotoIsInFlightStopsWithoutReplayingTheMove()throws Exception{
        CountDownLatch sent=new CountDownLatch(1),release=new CountDownLatch(1),stopped=new CountDownLatch(1);List<String> calls=new CopyOnWriteArrayList<>();AtomicInteger emergency=new AtomicInteger();
        UnionClefNavigation.Backend backend=new UnionClefNavigation.Backend(){public void initialize(){}public JsonObject call(String name,JsonObject args)throws Exception{
            calls.add(name);if(name.equals("gotoXYZ")){sent.countDown();assertTrue(release.await(2,TimeUnit.SECONDS));}if(name.equals("stopPathing"))stopped.countDown();
            JsonObject r=new JsonObject();r.addProperty("ok",true);r.addProperty("busy",false);return r;
        }};
        var nav=new UnionClefNavigation(backend,emergency::incrementAndGet);
        try{nav.start(1,64,2);assertTrue(sent.await(2,TimeUnit.SECONDS));nav.stop();assertTrue(emergency.get()>0);assertFalse(nav.available());assertThrows(IllegalStateException.class,()->nav.start(2,64,2));release.countDown();assertTrue(stopped.await(2,TimeUnit.SECONDS));
            for(int i=0;i<100&&!nav.available();i++)Thread.sleep(10);
            assertFalse(nav.available(),"an acknowledgement cannot settle a cancelled in-flight start");nav.enforceStop();assertTrue(emergency.get()>1);assertEquals(1,Collections.frequency(calls,"gotoXYZ"));assertFalse(nav.started());
        }finally{release.countDown();nav.close();}
    }
    @Test void observedArrivalAndConfirmedStopAllowAnotherRoute()throws Exception{
        AtomicInteger polls=new AtomicInteger();var nav=new UnionClefNavigation(new UnionClefNavigation.Backend(){public void initialize(){}public JsonObject call(String n,JsonObject a){JsonObject r=new JsonObject();r.addProperty("ok",true);r.addProperty("busy",false);if(n.equals("pathStatus")&&polls.incrementAndGet()>1)r.addProperty("arrived",true);return r;}},()->{});
        try{nav.start(1,64,2);for(int i=0;i<100&&!nav.started();i++)Thread.sleep(10);assertTrue(nav.started());nav.poll();for(int i=0;i<100&&!nav.arrived();i++)Thread.sleep(10);assertTrue(nav.arrived());nav.stop();for(int i=0;i<100&&!nav.available();i++)Thread.sleep(10);assertTrue(nav.available());}finally{nav.close();}
    }
    @Test void busyForeignTaskIsNotStoppedOrReplaced()throws Exception{
        List<String> calls=new CopyOnWriteArrayList<>();AtomicInteger emergency=new AtomicInteger();
        var nav=new UnionClefNavigation(new UnionClefNavigation.Backend(){public void initialize(){}public JsonObject call(String n,JsonObject a){calls.add(n);JsonObject r=new JsonObject();r.addProperty("ok",true);r.addProperty("busy",true);return r;}},emergency::incrementAndGet);
        try{nav.start(1,64,2);for(int i=0;i<100&&nav.error()==null;i++)Thread.sleep(10);assertEquals("navigation_stopped",nav.error());nav.stop();assertFalse(calls.contains("gotoXYZ"));assertEquals(0,emergency.get());}finally{nav.close();}
    }
}
