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

// Pulls one heading's subtree out of an HTML document.
//
// A section ends at the next heading of the same or shallower level, so an h3
// nested under an h2 travels with its parent while the following h2 does not.
//
// Two things are reported rather than guessed at. A title that matches more
// than one heading is flagged ambiguous instead of silently resolving to the
// first — real pages carry near-duplicate headings, one sampled page has both
// "Auras" and "Auras " with trailing whitespace. And a title that matches
// nothing comes back with the list of headings that do exist, so a caller can
// correct itself in one more call rather than guessing blind.
export function extractSection(html, headingTitle) {
  const empty = { found: false, html: "", matchCount: 0, availableHeadings: [] };
  if (!html) return empty;

  const HEADING = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  for (const m of String(html).matchAll(HEADING)) {
    headings.push({
      level: Number(m[1]),
      title: htmlToText(m[2]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  const availableHeadings = headings.map((h) => h.title);
  if (headings.length === 0) return { ...empty, availableHeadings: [] };

  const wanted = String(headingTitle ?? "").trim().toLowerCase();
  const matches = headings.filter((h) => h.title.trim().toLowerCase() === wanted);

  if (matches.length === 0) {
    return { found: false, html: "", matchCount: 0, availableHeadings };
  }

  const target = matches[0];
  // Runs to the next heading at the same level or shallower; deeper headings
  // are subsections and belong to this one.
  const next = headings.find((h) => h.start > target.start && h.level <= target.level);
  const body = String(html).slice(target.end, next ? next.start : undefined);

  return {
    found: true,
    matchCount: matches.length,
    heading: target.title,
    level: target.level,
    html: body,
    availableHeadings,
    ...(matches.length > 1
      ? {
          ambiguous: `Heading "${headingTitle}" matches ${matches.length} headings on this page; `
            + "the first was returned. Titles differing only in whitespace or case are treated as "
            + "the same heading.",
        }
      : {}),
  };
}

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
