/**
 * A cheap check after drafting: does the draft repeat an internal passage word for word?
 *
 * The prompt tells the model to follow internal notes but never quote them. That's only an
 * instruction: an email can steer the model into pasting a note into the reply. This catches
 * the paste, so the approver is warned (and, later, autopilot can refuse to send).
 *
 * Pure: text in, answer out. No I/O, so callers decide where the passages come from.
 */

/**
 * A run this many words long, shared word for word with an internal passage, is a quote.
 * Not lower: notes often script a short line to say ("tell them a teammate will apply it within
 * one business day"), and a draft that says it is following the note, not leaking it.
 */
const minQuoteWords = 10;
/**
 * …and it must carry this many distinct content words. Support mail is full of long stock
 * phrases ("please let us know if you have any questions") that a note may share by chance.
 */
const minQuoteContentWords = 4;

// Function words and support-mail boilerplate: shared runs made only of these aren't quotes.
const common = new Set(
  (
    "a an the and or but if so of to in on at by for from with without into onto about as is " +
    "are was were be been being am do does did done have has had having will would shall should " +
    "can could may might must not no yes this that these those it its it's i i'm i've me my we " +
    "we're we've we'll us our ours you you're you've you'll your yours he she they them their " +
    "there here what which who whom when where why how all any some each more most very just " +
    "also than then too up out over again once only own same such please thanks thank kind " +
    "regards best hi hello dear let know feel free hesitate reach contact help happy glad " +
    "questions question further anything else get got sorry"
  ).split(" "),
);

const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

/** Lowercase words, punctuation and spacing ignored, so reflowed or re-punctuated text matches. */
export function quoteWords(text: string): string[] {
  return (
    (
      text
        .toLowerCase()
        // Curly apostrophes, as a model or a mail client may write them.
        .replace(/[‘’]/g, "'")
        .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []
    ).flatMap((word) =>
      Array.from(wordSegmenter.segment(word))
        .filter((part) => part.isWordLike)
        .map((part) => part.segment),
    )
  );
}

/**
 * The longest stretches of the draft found word for word in one of `passages`, as words.
 * Only stretches of at least `minQuoteWords` words. For tests and for showing the match.
 */
export function sharedRuns(draft: string, passages: readonly string[]): string[][] {
  const words = quoteWords(draft);
  const n = minQuoteWords;
  if (words.length < n) return [];
  const grams = new Set<string>();
  for (const passage of passages) {
    const p = quoteWords(passage);
    for (let i = 0; i + n <= p.length; i++) grams.add(p.slice(i, i + n).join(" "));
  }
  if (grams.size === 0) return [];

  // Overlapping matching windows merge into one run. A run may stitch two passages together:
  // still text from the team's notes, so still worth a warning.
  const runs: string[][] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i + n <= words.length; i++) {
    if (!grams.has(words.slice(i, i + n).join(" "))) continue;
    if (start >= 0 && i <= end) {
      end = i + n;
    } else {
      if (start >= 0) runs.push(words.slice(start, end));
      start = i;
      end = i + n;
    }
  }
  if (start >= 0) runs.push(words.slice(start, end));
  return runs;
}

/** True when the draft repeats a long, substantive run of an internal passage word for word. */
export function quotesInternalPassage(draft: string, internalPassages: readonly string[]): boolean {
  return sharedRuns(draft, internalPassages).some(
    (run) => new Set(run.filter((w) => !common.has(w))).size >= minQuoteContentWords,
  );
}
