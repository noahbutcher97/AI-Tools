// Shared HTML-to-text conversion.
//
// Confluence page bodies and Miro item content both arrive as HTML, and both
// bridges need a readable-text form of it. This lives in lib/ rather than in
// either bridge so the two cannot drift into different behaviour — the same
// reasoning as the shared tool-result helpers next door.
//
// Confluence-specific wrappers matter disproportionately: `<ac:*>` (macros,
// attachments, images) and `<ri:*>` (resource identifiers) carry most of the
// weight on a large page and none of the prose. On a sampled page this cut
// 12,964 characters to 3,055.

const AC_SELF_CLOSING = /<ac:[^>]*\/>/gi;
const AC_BLOCK = /<ac:([a-z0-9-]+)[^>]*>[\s\S]*?<\/ac:\1>/gi;
const RI_TAG = /<ri:[^>]*\/?>/gi;
const ANY_TAG = /<[^>]+>/g;

export function htmlToText(html) {
  if (!html) return "";

  return String(html)
    // Macro wrappers go with their contents — the contents are parameters and
    // attachment metadata, not readable text.
    .replace(AC_SELF_CLOSING, " ")
    .replace(AC_BLOCK, " ")
    .replace(RI_TAG, " ")
    // Tags become a space, not nothing. Removing them outright welds adjacent
    // blocks together: "<li>one</li><li>two</li>" would read as "onetwo".
    .replace(ANY_TAG, " ")
    // Entities are decoded only after tags are gone, so an encoded "&lt;" in
    // prose is never re-read as the start of a tag. &amp; is decoded last for
    // the same reason: decoding it first would turn "&amp;lt;" into "<".
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
