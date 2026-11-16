// The links the editor writes, "[[ target | name ]]", so that Phorge reads
// them as links: its rule (PhutilRemarkupDocumentLinkRule) takes no "|" or
// "]" in the target and no "]" in the name, where the first "]]" ends the
// link ("IMG_0814[1].JPG" would end it after "IMG_0814[1").

/** A name for a link: brackets become parentheses, white space one space. */
export function linkName(name: string): string {
  return name.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
}

/** A target for a link: "|", brackets and white space percent-encoded, as in a URL. */
export function linkTarget(target: string): string {
  return target
    .trim()
    .replace(/\s/g, (space) => (space === " " ? "%20" : ""))
    .replace(/\|/g, "%7C")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}

/** "[[ target | name ]]", or "[[ target ]]" without a name. */
export function linkMarkup(target: string, name?: string): string {
  const shown = name === undefined ? "" : linkName(name);
  return shown ? `[[ ${linkTarget(target)} | ${shown} ]]` : `[[ ${linkTarget(target)} ]]`;
}
