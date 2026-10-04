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
}
