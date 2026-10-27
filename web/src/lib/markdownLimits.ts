// Defense-in-depth against a pathological text block locking the tab.
// A user message whose text is a ~50KB unbroken base64 data URL
// — e.g. an image block accidentally serialized into the text stream — both
// jams the full markdown pipeline (Shiki/KaTeX/mermaid + rehype) on the main
// thread AND forces the browser to lay out one ~50K-char line with no break
// opportunities. Either heuristic below routes such a block to plain,
// break-anywhere rendering that bypasses markdown entirely.
//
// `MAX_MARKDOWN_TEXT_LENGTH`: total size above which we never run markdown.
// `MAX_UNBROKEN_TOKEN_LENGTH`: longest run of non-whitespace chars above which
//   layout becomes pathological regardless of total size (base64, long URLs).
const MAX_MARKDOWN_TEXT_LENGTH = 50_000;
const MAX_UNBROKEN_TOKEN_LENGTH = 5_000;

/**
 * Longest run of consecutive non-whitespace characters in `text`. ASCII
 * whitespace (space, tab, CR, LF, FF, VT) resets the run — those are the
 * break opportunities the layout engine can use. O(n), single pass.
 */
function longestUnbrokenRun(text: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // 32 = space; 9..13 = tab, LF, VT, FF, CR.
    if (code === 32 || (code >= 9 && code <= 13)) {
      current = 0;
    } else {
      current += 1;
      if (current > max) max = current;
    }
  }
  return max;
}

/**
 * Whether `text` should bypass the markdown pipeline because rendering it
 * there would risk locking the tab. See the constants above for the why.
 */
export function isPathologicalText(text: string): boolean {
  return (
    text.length > MAX_MARKDOWN_TEXT_LENGTH || longestUnbrokenRun(text) > MAX_UNBROKEN_TOKEN_LENGTH
  );
}
