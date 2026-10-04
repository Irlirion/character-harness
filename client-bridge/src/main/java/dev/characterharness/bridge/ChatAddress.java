package dev.characterharness.bridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.network.message.FilterMask;
import net.minecraft.text.Text;

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

    static String extract(String signedContent, FilterMask filterMask, Pattern addressed) {
        if (signedContent == null || filterMask == null) return null;
        Text visibleContent = filterMask.getFilteredText(signedContent);
        return visibleContent == null ? null : extract(visibleContent.getString(), addressed);
    }
}
