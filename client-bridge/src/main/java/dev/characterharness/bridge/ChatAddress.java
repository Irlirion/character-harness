package dev.characterharness.bridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class ChatAddress {
    private ChatAddress() {}

    static Pattern pattern(String characterName) {
        return Pattern.compile("^\\s*(?:@" + Pattern.quote(characterName) + "(?![\\p{L}\\p{N}_])\\s*[:,]?\\s*|"
                + Pattern.quote(characterName) + "\\s*[:,]\\s*)", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    static String extract(String signedContent, Pattern addressed) {
        if (signedContent == null) return null;
        Matcher matcher = addressed.matcher(signedContent);
        if (!matcher.find()) return null;
        String text = signedContent.substring(matcher.end()).trim();
        return text.isEmpty() ? null : text;
    }
}
