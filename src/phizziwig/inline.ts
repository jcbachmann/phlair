// Finds the inline markup of a remarkup block the way Phorge's engine does:
// formatting, links, references, mentions and everything else its inline
// rules render, as ranges of the source text.
//
// This is a port of how PhutilRemarkupBlockRule::applyRules() runs the inline
// rules (phorge/src/infrastructure/markup) on the text of a block, and of
// each rule's pattern. Phorge applies the rules one after the other to the
// whole block, not per line, so "**bold\nacross lines**" is bold. A rule
// that renders something stores its HTML and puts a token ("\x01<n>Z") in
// its place: later rules do not see the text any more, only the token. The
// port does the same: it keeps the text the rules see as pieces that know
// where they came from in the source, and replaces matches with the same
// tokens, so later patterns match exactly what they match in Phorge (a
// token's "Z" is a word character, e.g. "T1@alice" is no mention).
//
// Formatting (bold, italic, struck through, underlined and highlighted
// text) is different: those rules come last and replace their markers with
// HTML tags in the text, without storing anything. Later formatting rules
// see the tags and match across them, so Phorge's HTML can nest wrongly
// ("**a //b** c//" gives "<strong>a <em>b</strong> c</em>"); the tokens
// here follow how a browser parses that HTML (see buildTree()).
//
// test/inline.test.ts compares the result with the PHP engine's rendering.
//
// Derived from Phabricator (Copyright Phacility, Inc., Apache License 2.0;
// see licenses/Phabricator-LICENSE.txt and Phabricator-NOTICE.txt), changed.

import { EMOJI } from "./emoji";

export type InlineKind =
  /** "`x`" and "##x##": monospaced text, nothing in it is rendered. */
  | "monospace"
  /** "${{{strings.platform.server.name}}}": a string of the install, or the text. */
  | "eval"
  /** "[[ page ]]", "[[ https://… | name ]]" and "[name](https://…)": a wiki page or a link. */
  | "link"
  /** "@{config:key}": a link to a setting. */
  | "config"
  /** "{nav a > b}": a navigation path. */
  | "nav"
  /** "{key Ctrl K}": keys. */
  | "key"
  /** "{icon camera}": an icon. */
  | "icon"
  /** ":smile:": an emoji (the name is a known one; see emojiOf()). */
  | "emoji"
  /** "{src path}": a link to a file in a repository. */
  | "source"
  /** "@{name}", "@{type:name|title}": a Diviner (documentation) link. */
  | "symbol"
  /** "{image https://…}": an image from another site. */
  | "image"
  /** "{meme, src=…, above=…}": an image macro with text. */
  | "meme"
  /** "{anchor #name}": an invisible anchor. */
  | "anchor"
  /** "https://…", "<https://…>" and "{https://…}": a hyperlink (the last one renders as text). */
  | "url"
  /** "T12", "D3#7", "rXYZ123", "abcdef1234": a reference to an object, if it exists. */
  | "object"
  /** "{F12, size=full}", "{T12}", "{P3}": an object embedded, if it exists. */
  | "embed"
  /** "#tag": a project, if it exists. */
  | "project"
  /** "{PHID-TASK-…}": an object by its PHID, if it exists. */
  | "handle"
  /** "@alice": a user (unknown users are shown as unknown). */
  | "mention"
  /** A line that is only a name: an image macro, if one has the name. */
  | "macro"
  /** "{#ff0000}": a color code (which Phorge never finds; see hexColorRule). */
  | "color"
  | "bold"
  | "italic"
  | "del"
  | "underline"
  | "highlight";

export interface InlineToken {
  kind: InlineKind;
  /** The whole token. */
  from: number;
  to: number;
  /** Formatting, links with a name, etc.: where the content is; the markers are from..contentFrom and contentTo..to. */
  contentFrom?: number;
  contentTo?: number;
  /**
   * Tokens inside, where Phorge renders markup inside: in formatting (which
   * always has the list), and the emoji and strings Phorge put into text it
   * stored (e.g. "`${{{…}}}`", or "#tag:smile:" for a project that may not exist).
   */
  children?: InlineToken[];
}

export interface InlineOptions {
  /**
   * Whether an image macro has this name. Phorge renders a line that is only
   * a name as the macro's image, and leaves it as text (for later rules)
   * otherwise. Without this, every such line is a "macro" token, and the
   * caller finds out from the server whether it renders as one.
   */
  isMacro?: (name: string) => boolean;
  /**
   * Applies the rules in the order PHP 7 sorts them in (see PHP7_ORDER),
   * not PHP 8's. The dev container runs PHP 7.4.
   */
  php7?: boolean;
}

/** URI protocols Phorge links by default (its "uri.allowed-protocols"). */
export const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http", "https", "mailto"]);

/** The emoji Phorge renders for ":name:", or undefined if it renders the text. */
export function emojiOf(name: string): string | undefined {
  const key = name.replace(/-/g, "_");
  return Object.hasOwn(EMOJI, key) ? EMOJI[key] : undefined;
}

/**
 * The protocol of a URI as PhutilURI parses it: "" if it has none or its host
 * is not a valid host name (Phorge then renders the URI as text), null if
 * Phorge rejects the URI as ambiguous. An approximation of PHP's parse_url()
 * for the forms remarkup links have.
 */
export function uriProtocol(uri: string): string | null {
  if (/^[^/:]*:\/\/[^/]*[#?][^\n]*:/.test(uri)) {
    return null;
  }
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/([^/?#]*))?/.exec(uri);
  if (!match) {
    return "";
  }
  if (match[2] !== undefined) {
    const authority = match[3];
    const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
    if (host !== "" && !/^[\p{L}\p{N}]+[\p{L}\p{N}.-]*$/u.test(host)) {
      return "";
    }
  }
  return match[1];
}

// PHP's \s and \S without the "u" flag; JavaScript's also match Unicode spaces.
const S = "[ \\t\\n\\x0B\\f\\r]";
const NS = "[^ \\t\\n\\x0B\\f\\r]";
// PHP's "u" flag also turns on PCRE's UCP: \w, \d and \b are Unicode-aware in
// the patterns of the object rules ("ÄT1" and "T1ä" are no references).
const UW = "[\\p{L}\\p{N}_]";
// The token Phorge stores text as ("\x01<n>Z"): PhutilRemarkupBlockStorage.
const MAGIC = "\x01";

/** PHP's trim(): the offsets of the text without the whitespace around it. */
function phpTrim(text: string, from = 0, to = text.length): [number, number] {
  const blank = " \t\n\r\0\x0B";
  while (from < to && blank.includes(text[from])) {
    from++;
  }
  while (to > from && blank.includes(text[to - 1])) {
    to--;
  }
  return [from, to];
}

/** A run of the text the rules see: a source character, a stored token, an emoji or a tag. */
interface Piece {
  text: string;
  /** The source range the piece stands for. */
  from: number;
  to: number;
  /** A token Phorge stored, or an emoji (rendered as itself, so not a stored token). */
  token?: InlineToken;
  /** A tag of formatting, which replaced a marker. */
  tag?: { format: Format; open: boolean };
}

interface Format {
  kind: InlineKind;
  /**
   * Whether the HTML element is one of the parser's "formatting elements"
   * (<strong>, <em> and <u> are; <del> and <span> are not), which decides
   * what a browser does with wrongly nested tags.
   */
  reopens: boolean;
}

/** What a rule puts in place of a range of the text: a piece without its source range. */
interface Edit {
  start: number;
  end: number;
  piece: Omit<Piece, "from" | "to">;
}

/** The text the rules see, mapped back to the source. */
class Text {
  pieces: Piece[];
  /** The text as the rules see it. */
  w = "";
  /** Whether a formatting rule made the text HTML (PhutilSafeHTML): it does so even without a match. */
  html = false;
  /** For each character of w, the index of its piece. */
  private pieceAt: number[] = [];
  private tokens = 0;

  constructor(
    source: string,
    from: number,
    to: number,
    readonly isMacro: (name: string) => boolean,
  ) {
    this.pieces = [];
    for (let i = from; i < to; i++) {
      this.pieces.push({ text: source[i], from: i, to: i + 1 });
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.w = this.pieces.map((p) => p.text).join("");
    this.pieceAt = [];
    this.pieces.forEach((piece, index) => {
      for (let k = 0; k < piece.text.length; k++) {
        this.pieceAt.push(index);
      }
    });
  }

  /** The source range of a range of the text the rules see. */
  from(start: number): number {
    return this.pieces[this.pieceAt[start]].from;
  }
  to(end: number): number {
    return this.pieces[this.pieceAt[end - 1]].to;
  }

  /** Like isFlatText(): whether a range has no stored tokens in it. */
  flat(start: number, end: number): boolean {
    return !this.w.slice(start, end).includes(MAGIC);
  }

  /** Stores a range as a token, like PhutilRemarkupEngine::storeText(). */
  store(kind: InlineKind | null, start: number, end: number, content?: [number, number]): Edit {
    const text = `${MAGIC}${++this.tokens}Z`;
    if (kind === null) {
      return { start, end, piece: { text } };
    }
    const token: InlineToken = { kind, from: this.from(start), to: this.to(end) };
    if (content && content[1] > content[0]) {
      token.contentFrom = this.from(content[0]);
      token.contentTo = this.to(content[1]);
    }
    // Stored text keeps what earlier rules put in it, and that shows where
    // the text shows: emoji ("#tag:smile:" is "#tag😄" if no such project
    // exists), and evaluated strings in monospaced text ("`${{{…}}}`").
    const inner = this.pieces.slice(this.pieceAt[start], this.pieceAt[end - 1] + 1);
    const children = inner.flatMap((piece) => (piece.token ? [piece.token] : []));
    if (children.length > 0) {
      token.children = children;
    }
    return { start, end, piece: { text, token } };
  }

  /** Replaces ranges (in order, not overlapping) of the text. */
  apply(edits: Edit[]): void {
    if (edits.length === 0) {
      return;
    }
    const out: Piece[] = [];
    let next = 0;
    for (const edit of edits) {
      const first = this.pieceAt[edit.start];
      const last = this.pieceAt[edit.end - 1];
      // A match that starts inside a piece another edit of the same pass
      // replaced (the patterns here never produce one), or that starts or
      // ends inside a stored token: Phorge breaks the token then and renders
      // garbage ("`a`http://x.y" is "1Zhttp://x.y"); here the match is left
      // as text, keeping the token.
      const cut = (at: number): boolean => at > 0 && at < this.w.length && this.pieceAt[at - 1] === this.pieceAt[at];
      if (first < next || cut(edit.start) || cut(edit.end)) {
        continue;
      }
      while (next < first) {
        out.push(this.pieces[next++]);
      }
      out.push({ ...edit.piece, from: this.pieces[first].from, to: this.pieces[last].to });
      next = last + 1;
    }
    while (next < this.pieces.length) {
      out.push(this.pieces[next++]);
    }
    this.pieces = out;
    this.rebuild();
  }
}

type Rule = (text: Text) => void;

/** Rules that are applied one after the other, like the patterns of one Phorge rule. */
const sequence =
  (...rules: Rule[]): Rule =>
  (text) =>
    rules.forEach((rule) => rule(text));

/** Decides what to do with a match: edits, or null to leave it as it is (the text stays for later rules). */
type Decide = (match: RegExpExecArray, text: Text) => Edit[] | null;

/** Applies a pattern like preg_replace_callback(): all matches in the text as it is before the pass. */
function replace(pattern: RegExp, decide: Decide): Rule {
  return (text) => {
    const edits: Edit[] = [];
    for (const match of text.w.matchAll(pattern)) {
      const result = decide(match, text);
      if (result) {
        edits.push(...result);
      }
    }
    text.apply(edits);
  };
}

/** The range of a group of a match (patterns have the "d" flag). */
function group(match: RegExpExecArray, index: number): [number, number] | null {
  return match.indices?.[index] ?? null;
}

/** The range of a group without the whitespace around it, like trim(). */
function trimmed(match: RegExpExecArray, index: number, text: Text): [number, number] | null {
  const range = group(match, index);
  return range && phpTrim(text.w, range[0], range[1]);
}

const end = (match: RegExpExecArray): number => match.index + match[0].length;

/** Stores the whole match as a token if it has no tokens in it (most rules). */
function storeFlat(kind: InlineKind, content?: number): Decide {
  return (match, text) => {
    if (!text.flat(match.index, end(match))) {
      return null;
    }
    const range = content === undefined ? undefined : (group(match, content) ?? undefined);
    return [text.store(kind, match.index, end(match), range)];
  };
}

// Escapes "\x01" in the text itself, so it is never taken for a token.
const escapeRule = replace(/\x01/g, (match, text) => [text.store(null, match.index, end(match))]);

// "${{{strings.platform.server.name}}}". Phorge renders unknown expressions
// as their text, but stores them all the same.
const evalRule = replace(/\$\{\{\{([^\n]+?)\}\}\}/dg, (match, text) => {
  const expression = group(match, 1)!;
  return text.flat(expression[0], expression[1]) ? [text.store("eval", match.index, end(match))] : null;
});

// "##" can span lines, "`" can not; "`" must not follow a word character
// (but may be followed by one: "the `Foo`s").
const monospaceRule = replace(/##([\s\S]+?)##|\B`([^\n]+?)`/dg, (match, text) => [
  text.store("monospace", match.index, end(match), group(match, 1) ?? group(match, 2)!),
]);

/**
 * PhutilRemarkupDocumentLinkRule::markupDocumentLink(): whether a link is
 * linked as a URI (else it is a wiki page, or for "[name](…)", text).
 */
function isLinkURI(uri: string): boolean {
  let isURI = /(^\/)|(:\/\/)|(^#)|(^(?:mailto|tel):)/.test(uri);
  if (isURI && !uri.startsWith("/") && !uri.startsWith("#")) {
    const protocol = uriProtocol(uri);
    isURI = protocol !== null && ALLOWED_PROTOCOLS.has(protocol);
  }
  return isURI && uri !== "/";
}

// The patterns of both link rules have PCRE's "U" flag, which makes every
// quantifier lazy and every lazy one greedy; they are written out here.
const WIKI_LINK = /\B\[\[([^|\]]+?)(?:\|([^\]]+?))??\]\]\B/dg;
const NOT_S_PAREN = "[^ \\t\\n\\x0B\\f\\r()]";

function wikiLink(match: RegExpExecArray, text: Text, phriction: boolean): Edit[] {
  const name = trimmed(match, 2, text);
  // The Phriction rule ignores an empty name, and PHP's empty() also takes "0" for one.
  const named = name && !(phriction && match[2] === "0") ? name : undefined;
  return [text.store("link", match.index, end(match), named)];
}

// "[name](uri)", with some balancing of parentheses for Wikipedia's URIs.
const MARKDOWN_LINK = new RegExp(
  `\\B\\[([^\\]]+?)\\]\\((${S}*?${NOT_S_PAREN}*?(?:(?:\\([^ ()]*?\\))+?${NOT_S_PAREN}*?)??${S}*?)\\)\\B`,
  "dg",
);

const documentLinkRule = sequence(
  replace(WIKI_LINK, (match, text) => {
    if (!text.flat(match.index, end(match))) {
      return null;
    }
    // Wiki pages are left to the Phriction rule.
    const uri = trimmed(match, 1, text)!;
    return isLinkURI(text.w.slice(uri[0], uri[1])) ? wikiLink(match, text, false) : null;
  }),
  replace(MARKDOWN_LINK, (match, text) => {
    const uriRange = trimmed(match, 2, text)!;
    const uri = text.w.slice(uriRange[0], uriRange[1]);
    // Not "x[0][1](y)" in a discussion of C code: the URI needs a "/" or "@".
    if (uri === "" || /^["'`]/.test(uri) || (!/[/@]/.test(uri) && !uri.startsWith("tel:"))) {
      return null;
    }
    if (!text.flat(match.index, end(match)) || !isLinkURI(uri)) {
      return null;
    }
    return [text.store("link", match.index, end(match), trimmed(match, 1, text)!)];
  }),
);

const phrictionRule = replace(WIKI_LINK, (match, text) =>
  text.flat(match.index, end(match)) ? wikiLink(match, text, true) : null,
);

// Phorge leaves "@{config:key}" with an unknown key to the Diviner rule,
// which then stores it as a symbol unless a word character comes before
// it. The tokenizer does not know the keys, so it is always "config".
const configRule = replace(/@\{config:([^}]+)\}/dg, storeFlat("config"));

// The "{name …}" rules: a name, then anything up to "}", with "\" escaping.
// Phorge's "(?:[^}\\]+|\\.)*" is written without the nested quantifier,
// which matches the same but can not take exponential time in JavaScript.
const braces = (name: string): RegExp => new RegExp(`\\{${name}\\b((?:[^}\\\\]|\\\\[^\\n])*)\\}`, "dg");

const navigationRule = replace(braces("nav"), storeFlat("nav"));
const keyboardRule = replace(braces("key"), storeFlat("key"));
const iconRule = replace(braces("icon"), storeFlat("icon"));
const sourceLinkRule = replace(braces("(?:src|source)"), storeFlat("source"));

// ":name:" between non-word characters becomes the emoji itself, not a
// stored token: later rules see the emoji character.
const emojiRule = replace(new RegExp(`\\B:(${NS}+):\\B`, "dg"), (match, text) => {
  const emoji = emojiOf(match[1]);
  if (!text.flat(match.index, end(match)) || emoji === undefined) {
    return null;
  }
  const token: InlineToken = { kind: "emoji", from: text.from(match.index), to: text.to(end(match)) };
  return [{ start: match.index, end: end(match), piece: { text: emoji, token } }];
});

const divinerRule = replace(/(?:^|\B)@\{(?:([^:]+?):)?([^}|]+?)(?:[|]([^}]+))?\}/dg, storeFlat("symbol"));

// "{image uri}" or "{image src=uri, …}". Phorge declines unless the URI has
// a protocol; this checks that roughly, without parsing the options.
const imageRule = replace(/\{(image|img) ((?:[^}\\]|\\[^\n])*)\}/dg, (match, text) => {
  const args = match[2].trim();
  const uri = /^https?:\/\//i.test(args) ? args : /(?:^|[\s,])(?:src|uri|url)\s*=\s*["']?([^\s,"']*)/i.exec(args)?.[1];
  if (!uri || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
    return null;
  }
  return storeFlat("image")(match, text);
});

const memeRule = replace(/\{meme,((?:[^}\\]|\\[^\n])+)\}/dg, storeFlat("meme"));

// PhutilRemarkupAnchorRule::isValidAnchorName(): names Phorge would not
// change, so only lowercase letters, digits, single dashes and non-ASCII.
function isValidAnchorName(name: string): boolean {
  return name.replace(/[\x00-\x2F\x3A-\x60\x7B-\x7F]+/g, "-").replace(/^-+|-+$/g, "") === name;
}

const anchorRule = replace(new RegExp(`\\{anchor${S}+#([^ \\t\\n\\x0B\\f\\r}]+)\\}`, "dg"), (match, text) =>
  text.flat(match.index, end(match)) && isValidAnchorName(match[1]) ? storeFlat("anchor")(match, text) : null,
);

// Hyperlinks: "<uri>" (linked exactly), "{uri}" (rendered as text unless an
// extension handles it) and bare URIs. A URI never includes a stored token.
const URI = `\\w{3,32}://[^ \\t\\n\\x0B\\f\\r${MAGIC}]`;

function hyperlink(text: Text, start: number, finish: number, content?: [number, number]): Edit[] | null {
  const uri = content ? text.w.slice(content[0], content[1]) : text.w.slice(start, finish);
  // PhutilURI throws on ambiguous URIs, and then the rule leaves the text.
  if (uriProtocol(uri) === null) {
    return null;
  }
  return [text.store("url", start, finish, content)];
}

const hyperlinkRule = sequence(
  replace(new RegExp(`<(${URI}+?)>`, "dg"), (match, text) =>
    hyperlink(text, match.index, end(match), group(match, 1)!),
  ),
  replace(new RegExp(`\\{(${URI}+?)\\}`, "dg"), (match, text) =>
    hyperlink(text, match.index, end(match), group(match, 1)!),
  ),
  replace(new RegExp(`(?<!\\w)${URI}+`, "dg"), (match, text) => {
    // Punctuation at the end is not part of the URI ("see https://x.y/."),
    // and neither is a closing parenthesis without an opening one.
    let link = match[0].replace(/[;,.:!?]+$/, "");
    if (link.endsWith(")") && !link.includes("(")) {
      link = link.slice(0, -1);
    }
    return hyperlink(text, match.index, match.index + link.length);
  }),
);

// The object rules (PhabricatorObjectRemarkupRule): "{T12, options}" embeds
// and "T12" or "T12#anchor" references, for one prefix each.
//
// Phorge stores every match as a token and only later finds out whether the
// object exists; if not, the token renders as the original text. So later
// rules never see inside a reference, whether it exists or not: the
// tokenizer's candidates mask exactly what Phorge masks. The exceptions are
// object names matching "remarkup.ignored-object-names" (its default is
// below), which Phorge leaves as text for later rules.
const IGNORED_OBJECT_NAMES = /^(Q|V|M|P)\d$/;

function objectRule(prefix: string, id = "[1-9]\\p{Nd}*", refKind: InlineKind = "object"): Rule {
  // A reference must not follow "#", "@" or "-" ("#abcdef", "@T1",
  // "ABC-T1"), nor a word character; and no word character may follow it.
  const embed = new RegExp(`(?<!${UW})\\{${prefix}(${id})([,\\s](?:[^}\\\\]|\\\\[^\\n])*)?\\}(?!${UW})`, "dgu");
  const reference = new RegExp(`(?<![#@-])(?<!${UW})${prefix}(${id})(?:#([-\\p{L}\\p{N}_]+))?(?!${UW})`, "dgu");
  const markup =
    (kind: InlineKind): Decide =>
    (match, text) => {
      if (!text.flat(match.index, end(match)) || IGNORED_OBJECT_NAMES.test(match[0])) {
        return null;
      }
      return [text.store(kind, match.index, end(match))];
    };
  return sequence(replace(embed, markup("embed")), replace(reference, markup(refKind)));
}

// Commits: "rXYZ123", "rXYZabcdef", "R12:abcdef" or a bare hash of at least
// seven hexadecimal digits (also a seven digit number or a word like
// "acceded"); PhabricatorRepositoryCommitPHIDType::getCommitObjectNamePattern().
const COMMIT = "(?:r[A-Z]+:?|R[0-9]+:)[1-9]\\p{Nd}*|(?:r[A-Z]+:?|R[0-9]+:)[a-f0-9]{5,40}|[a-f0-9]{7,40}";

// Projects: "#name", where some characters can not appear, and "." not at
// the ends ("#dot." is "#dot" and a period).
const NEVER = `\\s?!,:;{}#()"'*/~`;
const PROJECT = `(?:[^.${NEVER}](?:[^${NEVER}]*[^.${NEVER}])?)`;

const handleRule = replace(/\{(PHID-[a-zA-Z0-9-]*)\}/dg, (match, text) =>
  text.flat(match.index, end(match)) && /^PHID-[^-]{4}-/.test(match[1])
    ? [text.store("handle", match.index, end(match))]
    : null,
);

// Phorge stores every mention and renders unknown users as such.
const mentionRule = replace(/(?<!\w|@)@([a-zA-Z0-9._-]*[a-zA-Z0-9_-])/dg, (match, text) => [
  text.store("mention", match.index, end(match)),
]);

// A line that is only a name. Phorge stores the line (with the whitespace
// before the name) if a macro has the name; otherwise it leaves the name
// (and drops that whitespace, which renders the same). The token here is
// only the name. Of the later rules, only underline can match inside a
// name that is no macro ("__init__").
const macroRule = replace(
  new RegExp(`(?<![^\\n])${S}*([a-zA-Z0-9:_\\x7f-\\uffff-]+)(?![^\\n])`, "dg"),
  (match, text) => (text.isMacro(match[1]) ? [text.store("macro", ...group(match, 1)!)] : null),
);

// "{#fff}" or "{#ff0000}". It never applies while the Projects application
// is installed: its rule comes first and stores "{#fff}" as an embed, or
// "#fff" as a reference if a word character follows the "}". The rule only
// works on plain text, so not after a formatting rule ran (its result is HTML).
const hexColorPattern = replace(/\B\{(#([0-9a-fA-F]{3}){1,2})\}/dg, (match, text) => [
  text.store("color", match.index, end(match), group(match, 1)!),
]);
const hexColorRule: Rule = (text) => {
  if (!text.html) {
    hexColorPattern(text);
  }
};

/** A formatting rule: its pattern's group 1 is the content, the markers are around it. */
function formatRule(kind: InlineKind, pattern: RegExp, tag: string): Rule {
  const format: Format = { kind, reopens: tag !== "del" && tag !== "span" };
  const open = tag === "span" ? '<span class="remarkup-highlight">' : `<${tag}>`;
  const apply = replace(pattern, (match) => {
    const content = group(match, 1)!;
    let closeStart = content[1];
    if (kind === "highlight") {
      // "!!x!!!!" is "x!!" highlighted: only two of the "!" are markers.
      // And "!!!!!" is five "!", not one highlighted.
      if (/^!+$/.test(match[1])) {
        return null;
      }
      closeStart = end(match) - 2;
    }
    return [
      { start: match.index, end: content[0], piece: { text: open, tag: { format, open: true } } },
      { start: closeStart, end: end(match), piece: { text: `</${tag}>`, tag: { format, open: false } } },
    ];
  });
  return (text) => {
    apply(text);
    text.html = true;
  };
}

const boldRule = formatRule("bold", /\*\*([\s\S]+?)\*\*/dg, "strong");
// Not after ":", so "https://" starts no italic text.
const italicRule = formatRule("italic", /(?<!:)\/\/([\s\S]+?)\/\//dg, "em");
const delRule = formatRule("del", new RegExp(`(?<!~)~~([^ \\t\\n\\x0B\\f\\r~][\\s\\S]*?~*)~~`, "dg"), "del");
const underlineRule = formatRule(
  "underline",
  new RegExp(`(?<!_|/)__([^ \\t\\n\\x0B\\f\\r_/][\\s\\S]*?_*)__(?!/|\\.${NS})`, "dg"),
  "u",
);
// Not across lines, unlike the other formatting.
const highlightRule = formatRule("highlight", /!!([^\n]+?)(!{2,})/dg, "span");

/**
 * The inline rules as PhabricatorMarkupEngine::newMarkupEngine() registers
 * them (its own, then each installed application's getRemarkupRules(), then
 * the custom rules), with their priorities. Phorge applies them sorted by
 * priority, lowest first (PhutilRemarkupBlockRule::updateRules(), msort()).
 */
const REGISTERED: [number, Rule][] = [
  [0, escapeRule],
  [50, evalRule],
  [100, monospaceRule],
  [1000, hexColorRule],
  [150, documentLinkRule],
  [200, navigationRule],
  [200, keyboardRule],
  [199, configRule], // before the Diviner rule, whose syntax it shares
  [200, iconRule],
  [200, emojiRule],
  [500, handleRule],
  [450, objectRule("D")], // Differential
  [450, objectRule("T")], // Maniphest
  [450, objectRule("", COMMIT)], // Diffusion commits
  [460, objectRule("r", "[A-Z]+")], // repositories by callsign
  [460, objectRule("R", "[0-9]+")], // repositories by ID
  [200, sourceLinkRule],
  [175, phrictionRule],
  [450, objectRule("#", PROJECT, "project")],
  [450, objectRule("W")], // Dashboard panels
  [450, objectRule("M", "[1-9]\\p{Nd}*(?:/[1-9]\\p{Nd}*/?)?")], // Pholio, also "M12/34/"
  [450, objectRule("J")], // Phame posts
  [450, objectRule("Z")], // Conpherence
  [500, mentionRule],
  [450, objectRule("P")], // Paste
  [450, objectRule("K")], // Passphrase
  [450, objectRule("Q")], // Ponder
  [450, objectRule("O")], // Owners
  [450, objectRule("V")], // Slowvote
  [450, objectRule("S")], // Spaces
  [450, objectRule("C")], // Countdown
  [200, divinerRule],
  [450, objectRule("F")], // Files
  [200, imageRule],
  [450, objectRule("B")], // Harbormaster
  [450, objectRule("H")], // Herald
  [450, objectRule("L")], // Legalpad
  [400, hyperlinkRule],
  [500, macroRule],
  [200, memeRule],
  [1000, boldRule],
  [1000, italicRule],
  [1000, delRule],
  [1000, underlineRule],
  [1000, highlightRule],
  [200, anchorRule],
  // The color rule again, as a custom rule (it is one).
  [1000, hexColorRule],
];

// PHP 7's sort is not stable: it orders rules of equal priority differently,
// here as PHP 7.4 does for the rules above (the dev container's order; by
// index into them). It matters where such rules overlap: nested braces
// ("{icon {key x}}", "@{nav x}"), and a reference right after an embed
// ("{F1}T1": in PHP 8's order "T1" is stored first, so no word character
// follows "{F1}" and it is an embed; in PHP 7's, it is "{", "F1" and "}").
const PHP7_ORDER = [
  0, 1, 2, 4, 17, 7, 45, 16, 31, 33, 39, 9, 8, 6, 5, 37, 35, 26, 32, 30, 29, 28, 27, 34, 18, 25, 24, 22, 21, 20, 19, 13,
  12, 11, 36, 15, 14, 23, 38, 10, 40, 41, 42, 43, 44, 3, 46,
];

const PHP7_RULES = PHP7_ORDER.map((index) => REGISTERED[index][1]);

// PHP 8 sorts stably: equal priorities keep the order of registration.
const PHP8_RULES = REGISTERED.map(([priority, rule], index) => ({ priority, rule, index }))
  .sort((a, b) => a.priority - b.priority || a.index - b.index)
  .map(({ rule }) => rule);

/**
 * Builds the tokens from the final text: stored tokens where they are, and
 * formatting where its tags are, nested the way a browser parses Phorge's
 * HTML. Formatting that starts inside other formatting and ends after it
 * ("**a //b** c//") is cut at the end of the outer one; a browser reopens
 * <strong>, <em> and <u> after it (the "formatting elements" of the HTML
 * parser: two tokens, the second without an opening marker) and ends <del>
 * and highlighting there (their closing marker renders as nothing: a token
 * with only that marker). This is the HTML parser's handling of misnested
 * tags (the stack of open elements, the list of active formatting elements
 * and their reconstruction), for these elements only.
 */
function buildTree(pieces: Piece[], textEnd: number): InlineToken[] {
  const root: InlineToken[] = [];
  const stack: { format: Format; token: InlineToken }[] = [];
  const active: Format[] = [];
  const current = (): InlineToken[] => (stack.length > 0 ? stack[stack.length - 1].token.children! : root);
  const onStack = (format: Format): boolean => stack.some((open) => open.format === format);
  const open = (format: Format, from: number, contentFrom: number): void => {
    const token: InlineToken = { kind: format.kind, from, to: from, contentFrom, contentTo: contentFrom, children: [] };
    current().push(token);
    stack.push({ format, token });
  };
  const closeTop = (contentTo: number, to: number): void => {
    const { token } = stack.pop()!;
    token.contentTo = contentTo;
    token.to = to;
  };
  // Before content, formatting elements a closing tag ended are reopened.
  const reconstruct = (at: number): void => {
    if (active.length === 0 || onStack(active[active.length - 1])) {
      return;
    }
    let i = active.length - 1;
    while (i > 0 && !onStack(active[i - 1])) {
      i--;
    }
    for (; i < active.length; i++) {
      open(active[i], at, at);
    }
  };

  for (const piece of pieces) {
    if (piece.tag?.open) {
      reconstruct(piece.from);
      open(piece.tag.format, piece.from, piece.to);
      if (piece.tag.format.reopens) {
        active.push(piece.tag.format);
      }
    } else if (piece.tag) {
      const format = piece.tag.format;
      if (onStack(format)) {
        while (stack[stack.length - 1].format !== format) {
          closeTop(piece.from, piece.from);
        }
        closeTop(piece.from, piece.to);
      } else {
        // A closing tag of an element that is no longer open renders as nothing.
        const token: InlineToken = { kind: format.kind, from: piece.from, to: piece.to, children: [] };
        token.contentFrom = token.contentTo = piece.from;
        current().push(token);
      }
      const index = active.indexOf(format);
      if (index >= 0) {
        active.splice(index, 1);
      }
    } else {
      reconstruct(piece.from);
      if (piece.token) {
        current().push(piece.token);
      }
    }
  }
  while (stack.length > 0) {
    closeTop(textEnd, textEnd);
  }
  return root;
}

/**
 * The inline markup of the text of one block (a paragraph, a list item's
 * text, a header's text, a table cell), possibly of several lines: tokens in
 * source order, not overlapping, with ranges into the text. Like Phorge,
 * the whitespace around the text is ignored.
 */
export function tokenizeInline(text: string, options: InlineOptions = {}): InlineToken[] {
  const [from, to] = phpTrim(text);
  const working = new Text(text, from, to, options.isMacro ?? (() => true));
  for (const rule of options.php7 ? PHP7_RULES : PHP8_RULES) {
    rule(working);
  }
  return buildTree(working.pieces, to);
}
