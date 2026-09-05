/* eslint-env node */
/* eslint-disable no-undef */
// Availability emojis/words that indicate an item is still available
const AVAILABLE_SIGNALS = ['✅', '🟢', '🆓', 'free', 'available', 'פנוי', 'פנויה', 'חינם', 'זמין'];
// Signals that indicate item is taken
const TAKEN_SIGNALS = ['💾', '❌', '🔴', 'taken', 'sold', 'gone', 'נלקח', 'נתפס', 'נמכר', 'אזל'];

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a message matches any of the keywords as WHOLE WORDS.
 * Uses Unicode-aware boundaries (\p{L} any letter, \p{N} any number) so it works
 * for Hebrew too — "תיק" will NOT match inside "תיקון".
 * Returns { matched: boolean, keywords: string[] }
 */
function wholeWordTest(content, kw) {
  const escaped = escapeRegExp((kw || '').trim().toLowerCase());
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(content);
}

/**
 * Check if a message matches the wishlist keywords.
 *  - matchMode 'all' (AND): every keyword must appear (as a whole word).
 *  - matchMode 'any' (OR) [default]: at least one keyword must appear.
 *  - excludeKeywords: if ANY appears as a whole word, the message is skipped.
 * Returns { matched: boolean, keywords: string[] }
 */
function checkMatch(content, keywords, matchMode, excludeKeywords) {
  if (!content || !keywords || keywords.length === 0) return { matched: false, keywords: [] };

  // Exclusions take precedence — a single excluded word disqualifies the message.
  if (excludeKeywords && excludeKeywords.length > 0) {
    const hasExcluded = excludeKeywords.some(kw => wholeWordTest(content, kw));
    if (hasExcluded) return { matched: false, keywords: [] };
  }

  const matchedKeywords = keywords.filter(kw => wholeWordTest(content, kw));

  const matched = matchMode === 'all'
    ? matchedKeywords.length === keywords.length
    : matchedKeywords.length > 0;

  return { matched, keywords: matchedKeywords };
}

/**
 * Detect availability status from message content
 */
function detectAvailability(content) {
  const lower = content.toLowerCase();

  const isTaken = TAKEN_SIGNALS.some(s => lower.includes(s.toLowerCase()));
  if (isTaken) return 'taken';

  const isAvailable = AVAILABLE_SIGNALS.some(s => lower.includes(s.toLowerCase()));
  if (isAvailable) return 'available';

  return 'unknown';
}

module.exports = { checkMatch, detectAvailability };
