const NOT_SPOKEN = /[^\p{L}\p{N}\s]+/gu;

/**
 * Piper has no voice for emoji, dashes or quotes, and reads stray symbols as noise. The chat line
 * keeps them, so only the spoken copy is reduced to letters, digits and single spaces. Digits stay
 * because the character states counts and coordinates aloud.
 */
export function spokenText(text: string): string {
  return text.replace(NOT_SPOKEN, ' ').replace(/\s+/g, ' ').trim();
}