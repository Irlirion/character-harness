package dev.characterharness.bridge;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

final class PcmSegmenter {
    static final int SAMPLE_RATE = 48_000;
    static final int MAX_SAMPLES = SAMPLE_RATE * 8;
    static final int SILENCE_SAMPLES = (int) (SAMPLE_RATE * 0.7);
    static final int PRE_ROLL_SAMPLES = SAMPLE_RATE / 5;
    static final int POST_ROLL_SAMPLES = SAMPLE_RATE * 3 / 20;
    private static final int MAX_SPEAKERS = 2;
    private static final double SPEECH_RMS = 420;
    record Segment(UUID speaker, short[] samples) {}
    private final Map<UUID, Buffer> buffers = new LinkedHashMap<>();

    synchronized Segment accept(UUID speaker, short[] frame) {
        if (speaker == null) return null;
        if (frame == null || frame.length == 0) {
            Buffer old = buffers.remove(speaker);
            return old == null ? null : old.finish(speaker);
        }
        Buffer b = buffers.get(speaker);
        if (b == null) {
            while (buffers.size() >= MAX_SPEAKERS) { Buffer evicted=buffers.remove(buffers.keySet().iterator().next()); if(evicted!=null)evicted.clear(); }
            b = new Buffer(); buffers.put(speaker,b);
        }
        Segment segment = b.push(speaker, frame);
        if (segment != null) buffers.remove(speaker);
        return segment;
    }

    synchronized void clear() { buffers.values().forEach(Buffer::clear); buffers.clear(); }
    synchronized int trackedSpeakers() { return buffers.size(); }

    private static final class Buffer {
        private final short[] samples = new short[MAX_SAMPLES];
        private final short[] preRoll = new short[PRE_ROLL_SAMPLES];
        private int preRollUsed;
        private int preRollCursor;
        private int used;
        private int silentSamples;
        private boolean speaking;

        Segment push(UUID speaker, short[] frame) {
            boolean voiced = rms(frame) >= SPEECH_RMS;
            if (!speaking && !voiced) { rememberPreRoll(frame); return null; }
            if (!speaking) {
                speaking = true;
                appendPreRoll();
            }
            int take = Math.min(frame.length, MAX_SAMPLES - used);
            System.arraycopy(frame, 0, samples, used, take);
            used += take;
            if (voiced) silentSamples = 0; else silentSamples += take;
            if (silentSamples >= SILENCE_SAMPLES || used >= MAX_SAMPLES) return finish(speaker);
            return null;
        }

        Segment finish(UUID speaker) {
            if (!speaking) { clear(); return null; }
            int discardedSilence = Math.max(0, silentSamples - POST_ROLL_SAMPLES);
            int length = Math.max(0, used - discardedSilence);
            if (length == 0) { clear(); return null; }
            short[] bounded = new short[length];
            System.arraycopy(samples,0,bounded,0,length);
            clear();
            return new Segment(speaker,bounded);
        }

        void clear(){java.util.Arrays.fill(samples,(short)0);java.util.Arrays.fill(preRoll,(short)0);used=0;silentSamples=0;speaking=false;preRollUsed=0;preRollCursor=0;}

        private void rememberPreRoll(short[] frame) {
            for (short sample : frame) {
                preRoll[preRollCursor] = sample;
                preRollCursor = (preRollCursor + 1) % preRoll.length;
                if (preRollUsed < preRoll.length) preRollUsed++;
            }
        }

        private void appendPreRoll() {
            int start = preRollUsed == preRoll.length ? preRollCursor : 0;
            for (int i = 0; i < preRollUsed && used < MAX_SAMPLES; i++) {
                samples[used++] = preRoll[(start + i) % preRoll.length];
            }
            java.util.Arrays.fill(preRoll, (short) 0);
            preRollUsed = 0;
            preRollCursor = 0;
        }

        private static double rms(short[] data) {
            if (data.length == 0) return 0;
            double sum = 0;
            for (short s : data) sum += (double) s * s;
            return Math.sqrt(sum / data.length);
        }
    }
}
