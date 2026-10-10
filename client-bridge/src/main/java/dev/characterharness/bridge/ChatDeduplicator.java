package dev.characterharness.bridge;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** Drops one copy when the same visible line arrives over CHAT and GAME, but preserves same-path repeats. */
final class ChatDeduplicator {
    private static final long WINDOW_NANOS=TimeUnit.SECONDS.toNanos(2);
    private final Map<String,Seen> seen=new HashMap<>();
    private record Seen(String path,long nanos) {}

    synchronized boolean claim(String nickname,String text,String path,long nowNanos) {
        String key=nickname.toLowerCase(java.util.Locale.ROOT)+"\u0000"+text;
        Seen previous=seen.get(key);
        seen.entrySet().removeIf(entry->nowNanos-entry.getValue().nanos()>WINDOW_NANOS);
        if(previous!=null&&nowNanos-previous.nanos()<=WINDOW_NANOS&&!previous.path().equals(path))return false;
        seen.put(key,new Seen(path,nowNanos));
        return true;
    }
}
