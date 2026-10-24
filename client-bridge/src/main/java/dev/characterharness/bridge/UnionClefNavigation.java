package dev.characterharness.bridge;

import com.google.gson.JsonObject;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** MCP drives navigation; local emergency stop is independent of HTTP responsiveness. */
final class UnionClefNavigation implements AutoCloseable {
    interface Backend {
        void initialize() throws Exception;
        JsonObject call(String tool,JsonObject args) throws Exception;
    }
    private final Backend mcp;
    private final Runnable emergencyStop;
    private final ExecutorService io=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"unionclef-mcp");t.setDaemon(true);return t;});
    private final AtomicBoolean polling=new AtomicBoolean();
    private volatile long generation;
    private volatile boolean issued,started,arrived,stopping,observed,uncertain;
    private long nextPollNanos;
    private volatile String error;
    UnionClefNavigation(UnionClefMcp client,Runnable emergencyStop){this(new Backend(){
        public void initialize()throws Exception{client.initialize();}
        public JsonObject call(String name,JsonObject args)throws Exception{return client.call(name,args);}
    },emergencyStop);}
    UnionClefNavigation(Backend mcp,Runnable emergencyStop){this.mcp=mcp;this.emergencyStop=emergencyStop;}
    boolean started(){return started;}
    boolean arrived(){return arrived;}
    String error(){return error;}
    void start(int x,int y,int z){
        if(stopping)throw new IllegalStateException("UnionClef cleanup incomplete");
        long run=++generation;issued=false;started=false;arrived=false;observed=false;error=null;
        io.execute(()->{
            try{
                mcp.initialize();
                JsonObject status=mcp.call("pathStatus",new JsonObject());
                if(run!=generation)return;
                if(!status.has("busy")||status.get("busy").getAsBoolean()){error="navigation_stopped";return;}
                JsonObject args=new JsonObject();args.addProperty("x",x);args.addProperty("y",y);args.addProperty("z",z);
                issued=true;mcp.call("gotoXYZ",args);
                if(run==generation)started=true;
                else mcp.call("stopPathing",new JsonObject());
            }catch(Exception e){if(run==generation)error="unionclef_unavailable";}
        });
    }
    void poll(){
        if(!started||System.nanoTime()<nextPollNanos||!polling.compareAndSet(false,true))return;
        nextPollNanos=System.nanoTime()+250_000_000L;
        long run=generation;
        io.execute(()->{try{
            JsonObject status=mcp.call("pathStatus",new JsonObject());
            if(run==generation){arrived=status.has("arrived")&&status.get("arrived").getAsBoolean();observed|=arrived||(status.has("busy")&&status.get("busy").getAsBoolean());}
        }catch(Exception e){if(run==generation)error="unionclef_unavailable";}finally{polling.set(false);}});
    }
    boolean available(){return !stopping;}
    void enforceStop(){if(stopping&&issued)try{emergencyStop.run();}catch(RuntimeException e){error="unionclef_unavailable";}}
    void stop(){
        uncertain|=issued&&!observed;
        ++generation;started=false;stopping=true;
        if(issued)try{emergencyStop.run();}catch(RuntimeException e){error="unionclef_unavailable";}
        io.execute(()->{
            try{
                if(issued){
                    mcp.call("stopPathing",new JsonObject());
                    // An MCP acknowledgement only queues stop in UnionClef. Wait for idle.
                    for(int i=0;i<10;i++){
                        JsonObject status=mcp.call("pathStatus",new JsonObject());
                        if(status.has("busy")&&!status.get("busy").getAsBoolean()){if(!uncertain){issued=false;stopping=false;}return;}
                        Thread.sleep(100);
                    }
                    // Keep the local watchdog asserted on uncertain cleanup; restart to recover.
                }else stopping=false;
            }catch(Exception ignored){uncertain=true;}
        });
    }
    public void close(){stop();io.shutdown();}
}
