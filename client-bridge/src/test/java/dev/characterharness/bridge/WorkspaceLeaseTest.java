package dev.characterharness.bridge;
import org.junit.jupiter.api.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;
class WorkspaceLeaseTest {
 @Test void coreOutageStopsLocallyWithoutWaitingForHttp(){
  var lease=new WorkspaceLease();var stopped=new AtomicInteger();
  lease.accept("world",7,1000,stopped::incrementAndGet);
  assertTrue(lease.valid("world",3499));lease.enforce("world",3500,stopped::incrementAndGet);
  assertEquals(1,stopped.get());assertFalse(lease.valid("world",3500));
  lease.enforce("world",4000,stopped::incrementAndGet);assertEquals(1,stopped.get());
 }
 @Test void epochAndSessionChangesStopBeforeRenewing(){
  var lease=new WorkspaceLease();var stopped=new AtomicInteger();
  lease.accept("world",7,0,stopped::incrementAndGet);lease.accept("world",8,100,stopped::incrementAndGet);assertEquals(1,stopped.get());
  lease.enforce("other-world",200,stopped::incrementAndGet);assertEquals(2,stopped.get());assertFalse(lease.valid("other-world",200));
 }
}
