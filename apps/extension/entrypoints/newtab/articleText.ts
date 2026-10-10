/**
 * Amber stores article text as one flattened run: no paragraph breaks, with the
 * page furniture (title, byline, newsletter promos) still in front. This puts a
 * readable shape back on it, best-effort. It never drops body text.
 */

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/** "By Anthony Lane September 28, 2026" and its variants, with an optional clock time. */
const BYLINE_RE = new RegExp(
  `\\bBy [A-Z][\\s\\S]{2,240}?\\b${MONTH}\\.? \\d{1,2},? \\d{4}(?:,? \\d{1,2}:\\d{2}\\s?[apAP]\\.?[mM]\\.?(?:\\s?[A-Z]{2,3})?)?`,
);

/** Page furniture publishers leave in front of the story. Each pattern is anchored to the start. */
const HEAD_FURNITURE: RegExp[] = [
  /^[\s\S]{0,300}?Jump to comments section\s*/,
  new RegExp(`^[\\s\\S]{0,260}?\\bPublished ${MONTH} \\d{1,2},? \\d{4}(?: Updated ${MONTH} \\d{1,2},? \\d{4})?(?: \\d+)?\\s+(?=[A-Z])`),
  /^Stay informed with free updates\s+Simply sign up to the [^.]{0,100}? myFT Digest -- delivered directly to your inbox\.?\s*/,
  /^Unlock the Editor[’']s Digest for free\s+Roula Khalaf, Editor of the FT, selects her favourite stories in this weekly newsletter\.?\s*/,
  /^Unlock the [^.]{3,60}? newsletter for free\s+Your guide to what [^.]{0,120}? (?:means|mean) for [^.]{0,80}? and the world\s*/,
  /^[\u3400-\u9fff]+(?:\s+[\u3400-\u9fff]+)*\s*/,
  /^Sign up for (?:the|our) [^.]{0,80}?newsletter[^.]{0,60}?\.\s*(?:Get [^.]{3,100}\.\s*)?/,
  /^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}\s+Credit\.{3}[^]{0,120}?(?= By [A-Z])\s*/,
  /^1\.0 x Seek\s*/,
  /^,?\s*\d{1,2}:\d{2} [AP]M ET\s*/,
];

/** NYT-style photo credits, with the caption sentence that sits in front of them. */
const PHOTO_CREDIT = new RegExp(
  "(?:[^.!?]{10,220}[.!?]\\s+)?(?:Credit\\s+)?Credit\\.{3}\\s+(?:" +
    "(?:[A-Z][\\w.'’-]*\\s+){0,4}?[A-Z][\\w.'’-]*/(?:Associated Press|Reuters|Getty Images|The New York Times|Agence France-Presse|AFP|EPA|Bloomberg|Redux|Pool|Sipa USA|Shutterstock|Anadolu)" +
    "|(?:[A-Z][\\w.'’-]*\\s+){1,4}for The (?:New York )?Times" +
    ")\\s*",
  "g",
);

/** "Photograph by X for The New Yorker" run into the text where the picture was. */
const MAGAZINE_CREDIT =
  /(?:Photograph|Illustration|Collage|Photo-illustration)s? by [A-Z][^.]{2,90}? for The (?:New Yorker|Atlantic)\s*/g;

/** What follows the story: comment teasers, topic lists, subscription prompts. */
const TAIL_MARKERS: RegExp[] = [
  /\sWhat readers are saying\s/,
  /\sSee more on:\s/,
  /\sOrder Reprints \| Today[’']s Paper/,
  /\sShare full article\s/,
  /\sRelated Content\s/,
  /\s(?:A version of )?[Tt]his article appears in print on /,
  /\sCatch up quickly every weekday morning /,
  /\sExplore More Topics\s/,
  /\sShared with you by a Times subscriber\s*$/,
  /\sVideo: [^|]{3,140}\| FT Film\s*$/,
];
const TAIL_WINDOW = 1500;

/** A capture of the subscription page rather than the article. */
const PAYWALL_PAGE = /^(?:Subscribe to unlock this article|Try unlimited access|Subscribe to continue reading)/;

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "jr", "sr", "st", "no", "inc", "co", "corp", "ltd", "vs", "etc",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "gen", "sen", "rep", "gov", "lt", "col", "sgt", "prof", "mt", "rev", "hon", "capt",
]);

const TARGET_CHARS = 380;
const MAX_SENTENCES = 5;
const ORPHAN_CHARS = 140;

function foldQuotes(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function endsSentence(token: string, next: string | undefined): boolean {
  if (next === undefined) return true;
  const m = /^(.*?)([.!?]+)(["”’')\]]*)$/.exec(token);
  if (!m) return false;
  if (!/^[“"‘'(\[A-Z0-9]/.test(next)) return false;
  if (m[2].startsWith(".")) {
    const bare = m[1].replace(/^[“"‘'(\[]+/, "");
    if (/^[A-Z]$/.test(bare)) return false;
    if (ABBREVIATIONS.has(bare.toLowerCase())) return false;
    if (/^([A-Za-z]\.)+[A-Za-z]$/.test(bare)) return false;
  }
  return true;
}

function splitSentences(text: string): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const sentences: string[] = [];
  let current: string[] = [];
  tokens.forEach((token, i) => {
    current.push(token);
    if (endsSentence(token, tokens[i + 1])) {
      sentences.push(current.join(" "));
      current = [];
    }
  });
  if (current.length) sentences.push(current.join(" "));
  return sentences;
}

function quotesBalanced(s: string): boolean {
  const open = (s.match(/“/g) ?? []).length;
  const close = (s.match(/”/g) ?? []).length;
  const straight = (s.match(/"/g) ?? []).length;
  return open <= close && straight % 2 === 0;
}

function chunkSentences(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const sentence of splitSentences(text)) {
    current.push(sentence);
    length += sentence.length + 1;
    const joined = current.join(" ");
    if ((length >= TARGET_CHARS || current.length >= MAX_SENTENCES) && quotesBalanced(joined)) {
      out.push(joined);
      current = [];
      length = 0;
    }
  }
  if (current.length) {
    const rest = current.join(" ");
    if (out.length && rest.length < ORPHAN_CHARS) out[out.length - 1] += ` ${rest}`;
    else out.push(rest);
  }
  return out;
}

export interface ReadableText {
  /** The standfirst some publishers put between the headline and the byline. */
  deck?: string;
  paragraphs: string[];
  /** The capture is a subscription prompt, not the story. */
  paywallPage: boolean;
}

function trimTail(text: string): string {
  const from = Math.max(0, text.length - TAIL_WINDOW);
  const window = text.slice(from);
  let cut = -1;
  for (const marker of TAIL_MARKERS) {
    const hit = marker.exec(window);
    if (hit && (cut < 0 || hit.index < cut)) cut = hit.index;
  }
  return cut < 0 ? text : text.slice(0, from + cut).trimEnd();
}

export function toReadable(raw: string, title: string, author?: string): ReadableText {
  let text = raw.replace(/\r\n?/g, "\n").trim();

  const at = foldQuotes(text.slice(0, 400)).indexOf(foldQuotes(title));
  if (at >= 0 && title.length > 8) text = text.slice(at + title.length).trim();

  text = text.replace(PHOTO_CREDIT, "").replace(MAGAZINE_CREDIT, "").trim();

  const stripHead = () => {
    for (const re of HEAD_FURNITURE) text = text.replace(re, "");
    text = text.replace(/^[\s\-–—·|:]+/, "");
  };
  stripHead();

  let deck: string | undefined;
  const hit = BYLINE_RE.exec(text.slice(0, 700));
  // A real byline is short and has no quotation in it; anything else is body text that says "By ...".
  const byline = hit && hit[0].split(/\s+/).length <= 30 && !/[“”"]/.test(hit[0]) ? hit : null;
  if (byline) {
    const before = text.slice(0, byline.index).trim();
    if (before.length <= 420) deck = before || undefined;
    text = text.slice(byline.index + byline[0].length).trim();
    stripHead();
  }

  if (author) {
    const escaped = author.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^By ${escaped}\\s+`, "i"), "");
  }
  text = trimTail(text);
  const paywallPage = PAYWALL_PAGE.test(text);

  let paragraphs: string[];
  if (/\n\s*\n/.test(text)) paragraphs = text.split(/\n\s*\n/);
  else if (text.includes("\n")) paragraphs = text.split("\n");
  else paragraphs = chunkSentences(text);

  return {
    deck,
    paywallPage,
    paragraphs: paragraphs.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean),
  };
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
