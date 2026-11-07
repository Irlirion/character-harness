package dev.characterharness.bridge;

/** Client-side dead man switch: expires independently of core or MCP availability. */
final class WorkspaceLease {
    private long expires;
    private String session;
    private long epoch;
    private boolean armed;
    synchronized void accept(String session,long epoch,long now,Runnable stop){
        if(armed&&(!session.equals(this.session)||epoch!=this.epoch))stop.run();
        this.session=session;this.epoch=epoch;expires=now+2500;armed=true;
    }
    synchronized boolean valid(String session,long now){return armed&&java.util.Objects.equals(session,this.session)&&now<expires;}
    synchronized void enforce(String session,long now,Runnable stop){
        if(armed&&!valid(session,now)){stop.run();armed=false;}
    }
    synchronized void revoke(Runnable stop){if(armed){stop.run();armed=false;}}
}
