/**
 * NewDocPopover — one pane, one click: replaces the two native prompt()s the
 * prototype used for name + optional backing file path.
 */
import { useEffect, useRef, useState } from 'react'

interface Props {
  onCreate: (name: string, sourcePath: string | undefined) => Promise<void>
  onClose: () => void
}

export default function NewDocPopover({ onCreate, onClose }: Props) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const submit = async () => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      await onCreate(n, path.trim() || undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="New document"
      data-testid="inkwell-new-doc"
      className="absolute left-2 top-10 z-20 w-[300px] rounded-lg border border-border bg-bg-elevated shadow-lg p-3 flex flex-col gap-2 text-[12px]"
    >
      <label className="flex flex-col gap-0.5">
        <span className="text-muted">Name</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
           
          autoFocus
          placeholder="design-notes"
          aria-label="Document name"
          className="rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-text outline-none focus-ring"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted">Back with a file <span className="text-muted/70">(optional)</span></span>
        <input
          value={path}
          onChange={e => setPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          placeholder="/path/to/repo/docs/design.md"
          aria-label="Backing file path"
          className="rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus-ring font-mono"
        />
        <span className="text-[11px] text-muted">Blank keeps the document in the artifact store only. A path makes that file the canonical copy — the store writes through to it.</span>
      </label>
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-text cursor-pointer bg-transparent border-none">Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={!name.trim() || busy} className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[12px] text-accent hover:bg-accent/20 cursor-pointer disabled:opacity-50 disabled:cursor-default">
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  )
}
