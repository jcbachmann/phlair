import { Facet } from "@codemirror/state";

/** The textarea the editor stands in for; Phorge submits and reads it. */
export const hostTextarea = Facet.define<HTMLTextAreaElement, HTMLTextAreaElement | null>({
  combine: (values) => values[0] ?? null,
});
