/* eslint-env node */
// Availability emojis/words that indicate an item is still available
const AVAILABLE_SIGNALS = ['✅', '🟢', '🆓', 'free', 'available', 'פנוי', 'פנויה', 'חינם', 'זמין'];
// Signals that indicate item is taken
const TAKEN_SIGNALS = ['❌', '🔴', 'taken', 'sold', 'gone', 'נלקח', 'נתפס', 'נמכר', 'אזל'];

/**
 * Check if a message matches any of the keywords
 * Returns { matched: boolean, keywords: string[] }
 */
function checkMatch(content, keywords) {
  if (!content || !keywords || keywords.length === 0) return { matched: false, keywords: [] };

  const lower = content.toLowerCase();
  const matchedKeywords = keywords.filter(kw => lower.includes(kw.toLowerCase()));

  return {
    matched: matchedKeywords.length > 0,
    keywords: matchedKeywords,
  };
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