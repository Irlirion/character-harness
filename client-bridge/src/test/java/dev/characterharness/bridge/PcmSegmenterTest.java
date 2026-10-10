package dev.characterharness.bridge;

import org.junit.jupiter.api.Test;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class PcmSegmenterTest {
    private static short[] frame(int n, short value) { short[] a=new short[n]; java.util.Arrays.fill(a,value); return a; }

    @Test void segmentsOnSilenceAndBoundsTrailingSilence() {
        PcmSegmenter s=new PcmSegmenter(); UUID speaker=UUID.randomUUID();
        assertNull(s.accept(speaker,frame(4800,(short)1000)));
        PcmSegmenter.Segment segment=null;
        for(int i=0;i<7;i++) segment=s.accept(speaker,frame(4800,(short)0));
        assertNotNull(segment);
        assertEquals(speaker,segment.speaker());
        assertEquals(4800 + PcmSegmenter.POST_ROLL_SAMPLES,segment.samples().length);
        assertEquals(0,s.trackedSpeakers());
    }

    @Test void handlesEmptyEndMarkerAndCapsSegmentAtEightSeconds() {
        PcmSegmenter s=new PcmSegmenter(); UUID speaker=UUID.randomUUID();
        assertNull(s.accept(speaker,new short[0]));
        PcmSegmenter.Segment segment=null;
        for(int i=0;i<7;i++)assertNull(s.accept(speaker,frame(48000,(short)800)));
        segment=s.accept(speaker,frame(48000,(short)800));
        assertNotNull(segment); assertEquals(PcmSegmenter.MAX_SAMPLES,segment.samples().length);
        assertEquals(0,s.trackedSpeakers());
    }

    @Test void onlyKeepsTwoConcurrentSpeakerBuffers() {
        PcmSegmenter s=new PcmSegmenter();
        s.accept(UUID.randomUUID(),frame(4800,(short)700));
        s.accept(UUID.randomUUID(),frame(4800,(short)700));
        s.accept(UUID.randomUUID(),frame(4800,(short)700));
        assertEquals(2,s.trackedSpeakers());
    }

    @Test void preservesBoundedPreRollAndShortPostSilenceTail() {
        PcmSegmenter s=new PcmSegmenter(); UUID speaker=UUID.randomUUID();
        s.accept(speaker,frame(4800,(short)0));
        s.accept(speaker,frame(4800,(short)0));
        s.accept(speaker,frame(4800,(short)0));
        assertNull(s.accept(speaker,frame(4800,(short)1000)));
        PcmSegmenter.Segment segment=null;
        for(int i=0;i<7;i++) segment=s.accept(speaker,frame(4800,(short)0));
        assertNotNull(segment);
        assertEquals(PcmSegmenter.PRE_ROLL_SAMPLES + 4800 + PcmSegmenter.POST_ROLL_SAMPLES, segment.samples().length);
        assertEquals(0, segment.samples()[0]);
        assertEquals(1000, segment.samples()[PcmSegmenter.PRE_ROLL_SAMPLES]);
        assertEquals(0, segment.samples()[segment.samples().length-1]);
    }

    @Test void endMarkerKeepsOnlyTheBoundedPostRollAndNeverExceedsEightSeconds() {
        PcmSegmenter s=new PcmSegmenter(); UUID speaker=UUID.randomUUID();
        s.accept(speaker,frame(4800,(short)1000));
        s.accept(speaker,frame(4800,(short)0));
        PcmSegmenter.Segment segment=s.accept(speaker,new short[0]);
        assertNotNull(segment);
        assertEquals(4800 + 4800,segment.samples().length);
    }

    // Measured against this segmenter, not assumed: the minimum producible segment is 1 sample
    // (2 bytes), because push() starts recording on the first frame whose RMS clears SPEECH_RMS and
    // finish() emits whatever was recorded when the empty end-of-transmission frame arrives. The
    // service floor is 2880 bytes, so the segmenter can produce something the service refuses.
    @Test void producesASingleSampleSegmentFarBelowTheServiceFloor() {
        PcmSegmenter s=new PcmSegmenter(); UUID speaker=UUID.randomUUID();
        assertNull(s.accept(speaker,new short[0]));
        assertNull(s.accept(speaker,frame(1,(short)500)));
        PcmSegmenter.Segment segment=s.accept(speaker,new short[0]);
        assertNotNull(segment);
        assertEquals(1,segment.samples().length);
        assertTrue(segment.samples().length * Short.BYTES < SttServiceClient.MIN_REQUEST_BYTES);
    }

    // The reachable shape, not a synthetic one: finish() clears the pre-roll on every end, so a
    // speaker's second utterance starts with an empty one. A Fabric voice packet is 20 ms, and
    // 960 samples is 1920 bytes, already under the 2880-byte floor.
    @Test void secondUtteranceAfterAFinishLosesItsPreRollAndCanFallUnderTheServiceFloor() {
        PcmSegmenter s=new PcmSegmenter(); UUID speaker=UUID.randomUUID();
        assertNull(s.accept(speaker,frame(9600,(short)1000)));
        assertNotNull(s.accept(speaker,new short[0]));
        assertNull(s.accept(speaker,frame(960,(short)1000)));
        PcmSegmenter.Segment segment=s.accept(speaker,new short[0]);
        assertNotNull(segment);
        assertEquals(960,segment.samples().length);
        assertTrue(segment.samples().length * Short.BYTES < SttServiceClient.MIN_REQUEST_BYTES);
    }
}
