/**
 * Round-trip fidelity: the adversarial sweep's exact payload (2026-09-10) —
 * tables, task lists and an HTML comment were silently deleted on the first
 * keystroke. Tables and task lists must now survive; HTML comments must be
 * REPORTED so the page can refuse to autosave over them.
 */
import { describe, it, expect } from 'vitest'
import { roundTrip, roundTripLoss, contentWords } from '../apps/inkwell/roundTrip'

const SWEEP_PAYLOAD = `# adv-b-md

## Table

| A | B |
|---|---|
| 1 | 2 |

## Nested list

- parent
  - child
    - grandchild

## Tasks

- [ ] todo
- [x] done

## Code

\`\`\`python
def f():  # inline comment
    return 1
\`\`\`

<!-- an html comment -->

A line with two trailing spaces  
and a hard break above.

End.
`

describe('roundTrip fidelity', () => {
  it('tables survive a round-trip (content and structure)', () => {
    const out = roundTrip('| A | B |\n|---|---|\n| 1 | 2 |\n')
    expect(out).toMatch(/\|\s*A\s*\|\s*B\s*\|/)
    expect(out).toMatch(/\|\s*1\s*\|\s*2\s*\|/)
  })

  it('task-list checkboxes survive, including checked state', () => {
    const out = roundTrip('- [ ] todo\n- [x] done\n')
    expect(out).toMatch(/\[ \]\s*todo/)
    expect(out).toMatch(/\[x\]\s*done/i)
  })

  it('the sweep payload loses no words; only the HTML comment is reported', () => {
    const loss = roundTripLoss(SWEEP_PAYLOAD)
    expect(loss.missingWords).toEqual([])
    expect(loss.htmlComments).toBe(1)
    expect(loss.lossy).toBe(true) // the comment alone makes it lossy
  })

  it('a plain document is not lossy', () => {
    const md = '# T\n\nSome **bold** and _em_ text with a [link](https://x.y).\n\n- a\n- b\n\n> quote\n'
    expect(roundTripLoss(md)).toEqual({ missingWords: [], htmlComments: 0, lossy: false })
  })

  it('contentWords ignores syntax but keeps words', () => {
    const w = contentWords('| A | B |\n|---|---|\n- [x] **done**\n')
    expect([...w.keys()].sort()).toEqual(['A', 'B', 'done'])
  })

  it('genuinely unrepresentable content is reported as missing words', () => {
    // A definition list is not in the schema; its words must still not vanish
    // silently — if the parser drops them, the guard says so.
    const md = 'Term\n: Definition text here\n'
    const loss = roundTripLoss(md)
    // Either the editor keeps the words (as paragraphs) or reports them.
    if (loss.missingWords.length) expect(loss.lossy).toBe(true)
    else expect(roundTrip(md)).toMatch(/Definition text here/)
  })
})
