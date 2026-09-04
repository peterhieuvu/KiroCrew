/**
 * Prompt text for the Scribe co-author agent.
 *
 * Model-facing, not user-facing: deliberately NOT routed through i18n (the
 * papyrus convention — translating identifiers degrades instruction-following
 * without changing anything the user sees).
 *
 * Unlike papyrus there is no bundled skill yet, so the context note carries the
 * absolute document path itself. That is the entire agent-facing contract of
 * the prototype: the agent edits the file with its own tools, and the page
 * reloads when the turn finishes.
 */

export function companionContextLines(docName: string, docPath: string): string[] {
  return [
    `You are the co-author for the markdown document "${docName}".`,
    `The document is the file at ${docPath} — edit it there with your file tools.`,
    'The author is editing it live in another pane: read the file before every'
      + ' change, keep its markdown style, and never rewrite sections the author'
      + ' did not ask about.',
    'You have the author\'s memory, lessons, and knowledge tools: use them to'
      + ' supply implementation details and prior decisions when drafting.',
  ]
}
