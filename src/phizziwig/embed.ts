// File embeds like "{F123, size=full, layout=right, float, alt="A diagram"}".
//
// The options follow PhutilSimpleOptions: "key=value" or a bare "key" (true),
// separated by commas; values may be quoted with " or ' and use backslash
// escapes. Writing an embed keeps the order of the options it had.

export interface Embed {
  /** Offset of "{" in the text. */
  from: number;
  /** Offset after "}". */
  to: number;
  /** "F123" */
  monogram: string;
  options: [string, string | true][];
}

const EMBED = /\{(F\d+)((?:[,\s](?:[^}\\]|\\.)*)?)\}/g;

function parseOptions(text: string): [string, string | true][] {
  const options: [string, string | true][] = [];
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      current += c + text[++i];
    } else if (quote) {
      current += c;
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      current += c;
      quote = c;
    } else if (c === ",") {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current);
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (!key) {
      continue;
    }
    options.push([key, eq < 0 ? true : unquote(part.slice(eq + 1).trim())]);
  }
  return options;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  const inner = quoted ? quoted[2] : value;
  return inner.replace(/\\(.)/g, "$1");
}

function quote(value: string): string {
  return /[^a-zA-Z0-9]/.test(value) ? `"${value.replace(/[\\'"]/g, "\\$&")}"` : value;
}

/** Finds the file embeds in a text. */
export function findEmbeds(text: string): Embed[] {
  const embeds: Embed[] = [];
  EMBED.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMBED.exec(text))) {
    embeds.push({
      from: match.index,
      to: match.index + match[0].length,
      monogram: match[1],
      options: parseOptions(match[2]),
    });
  }
  return embeds;
}

export function getOption(embed: Embed, key: string): string | true | undefined {
  return embed.options.find(([k]) => k === key)?.[1];
}

/** Sets an option, or removes it with null. */
export function setOption(embed: Embed, key: string, value: string | true | null): Embed {
  const options = embed.options.filter(([k]) => k !== key);
  if (value !== null) {
    const index = embed.options.findIndex(([k]) => k === key);
    options.splice(index < 0 ? options.length : index, 0, [key, value]);
  }
  return { ...embed, options };
}

export function formatEmbed(embed: Embed): string {
  const options = embed.options.map(([key, value]) => (value === true ? key : `${key}=${quote(value)}`));
  return `{${[embed.monogram, ...options].join(", ")}}`;
}
