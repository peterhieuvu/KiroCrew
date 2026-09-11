/**
 * The editor's schema, in one place.
 *
 * Every consumer that parses or serializes a document — the live editor, the
 * lossy-load check, the headless test harness — must use THIS list, because
 * "what markdown survives a round-trip" is a property of the extension set.
 * The adversarial sweep (2026-09-10) found tables, task-list checkboxes and
 * HTML comments being silently deleted on the first keystroke: StarterKit has
 * no table or task nodes, so the parser dropped them and autosave persisted
 * the loss. Tables and task lists are now first-class (both have native
 * markdown parse/render in tiptap 3.30.x). HTML comments still have no node —
 * `roundTripLoss` reports them so the page can refuse to autosave over them.
 */
import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'

/** Content extensions (no UI plugins). Shared by editor, tests, and guards. */
export function contentExtensions(): AnyExtension[] {
  return [
    // openOnClick off: a click in an editable surface places the caret; the
    // toolbar link button is the navigation affordance.
    StarterKit.configure({ link: { openOnClick: false } }),
    Markdown,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
  ]
}
