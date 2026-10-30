import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

// Shared paper-inset chrome with CodeBlock — a diagram should sit in the
// bubble with the same calm frame a code block does.
const INSET: React.CSSProperties = {
  background: 'rgba(15, 30, 50, 0.035)',
  border: '1px solid var(--ink-100)',
  maxWidth: '100%',
}

// Mermaid parses and renders the diagram on a throwaway element; on a bad
// diagram it throws after (best-effort) leaving nodes behind. Sweep them so
// repeated failed renders don't pile up in <body>.
function sweepTemps(renderId: string) {
  for (const id of [renderId, `d${renderId}`]) {
    document.getElementById(id)?.remove()
  }
}

/** Lazily-rendered Mermaid diagram. A ```mermaid fence becomes an inline SVG
 *  inside the bubble; anything mermaid rejects falls back to the provided
 *  element (the regular CodeBlock) so the source is never lost. The mermaid
 *  chunk is dynamically imported and only loads on the first diagram. */
export function MermaidBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Mermaid interpolates the id into DOM nodes and CSS selectors — keep it
  // selector-safe and unique per mount, then per attempt (retries after the
  // code prop changes must not collide with a previous render's leftovers).
  const seed = useId().replace(/[^a-zA-Z0-9]/g, '')
  const seq = useRef(0)
  // initialize() is global per module load — only the first mount pays it.
  const initialized = useRef(false)

  useEffect(() => {
    let cancelled = false
    // Streaming re-renders pass growing code. A previous attempt may have
    // failed on a truncated diagram — clear both flags so a later complete
    // code isn't shadowed by the earlier failure (failed is checked first
    // during render).
    setSvg(null)
    setFailed(false)
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        if (!initialized.current) {
          mermaid.initialize({
            startOnLoad: false,
            // strict: no script/eval in diagrams, and mermaid sanitizes its
            // SVG output through DOMPurify — message content stays inert.
            securityLevel: 'strict',
            // neutral theme sits on Cumora's light paper palette.
            theme: 'neutral',
          })
          initialized.current = true
        }
        // parse() first so an invalid diagram throws before render() touches
        // the DOM at all.
        await mermaid.parse(code)
        seq.current += 1
        const renderId = `cumoraMmd${seed}${seq.current}`
        const { svg: rendered } = await mermaid.render(renderId, code)
        if (!cancelled) setSvg(rendered)
      } catch {
        sweepTemps(`cumoraMmd${seed}${seq.current}`)
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, seed])

  // Unparseable diagram → hand the raw source back to CodeBlock unchanged.
  if (failed) return <>{fallback}</>

  // Chunk loading / parsing placeholder — same frame, quiet label.
  if (svg == null) {
    return (
      <div
        className="my-1.5 rounded-[8px] flex items-center justify-center font-mono text-[10px] tracking-[0.14em] uppercase"
        style={{ ...INSET, color: 'var(--ink-300)', minHeight: 72 }}
      >
        diagram…
      </div>
    )
  }

  return (
    <div
      className="my-1.5 rounded-[8px] overflow-hidden"
      style={INSET}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid sanitizes its own SVG output through DOMPurify under securityLevel:'strict' — no script or event handlers survive into the bubble.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
