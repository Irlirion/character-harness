package dev.characterharness.bridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class VoiceAddress {
    private VoiceAddress() {}
    static String extract(String transcript,String name) {
        if(transcript==null||name==null)return null;
        Pattern pattern=Pattern.compile("^\\s*@?"+Pattern.quote(name)+"(?=$|[\\s,!.?:;\\-])\\s*[,!.?:;\\-]*\\s*(.+)$",Pattern.CASE_INSENSITIVE|Pattern.UNICODE_CASE);
        Matcher m=pattern.matcher(transcript.strip());
        if(!m.matches())return null;
        String text=m.group(1).strip();
        return text.isEmpty()?null:text;
    }
}
