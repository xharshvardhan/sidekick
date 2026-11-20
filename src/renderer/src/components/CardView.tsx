import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { Check, ChevronRight, CircleAlert } from 'lucide-react'
import { Markdown } from '@openai/apps-sdk-ui/components/Markdown'
import { ShimmerText } from '@openai/apps-sdk-ui/components/ShimmerText'
import type { Card, CardSection } from '../../../shared/types'
import { hasCode } from '../../../shared/hold'
import { useHotkey } from '../lib'

const KIND: Record<Card['source'], string> = {
  auto: 'They asked',
  ask: 'You asked',
  screen: 'On screen',
  deeper: 'In depth'
}

/** px at scale 1; everything in the card scales with `scale` (overlay text size setting). */
const px = (n: number, scale: number): string => `${(n * scale).toFixed(2)}px`

export function CardView({
  card,
  scale = 1,
  detailOpen = false,
  compact = false
}: {
  card: Card
  scale?: number
  /** Show detail fully expanded (the Live page has room for it). */
  detailOpen?: boolean
  /** Overlay: older sections hide behind one "N earlier" line instead of one row each. */
  compact?: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showOlder, setShowOlder] = useState(false)
  const streaming = card.status === 'streaming'
  const sections = card.sections
  const newest = sections[sections.length - 1]
  // Keep the previous section open until the new `say` line has finished streaming.
  const sayDone = !streaming || !newest || newest.points.length > 0 || newest.detail !== ''
  const ordered = [...sections].reverse() // newest on top, older below
  // Overlay: a follow-up must not push the code the user is typing from out of sight. When the newest section has
  // no code of its own, the latest code stays under it (until the earlier sections are opened).
  const carried =
    compact && newest && !hasCode(newest.detail) && !showOlder
      ? ordered.slice(1).find((s) => hasCode(s.detail))
      : undefined

  return (
    <div className="selectable" style={{ fontSize: px(14.5, scale) } as CSSProperties}>
      {!newest && streaming && (
        <ShimmerText className="font-medium text-secondary" as="p">
          Working out what to say…
        </ShimmerText>
      )}
      {ordered.map((s, i) => {
        const index = sections.length - 1 - i
        const isNewest = i === 0
        const hidden = compact && i > 0 && !showOlder
        const open = isNewest || expanded[s.id] || (!compact && i === 1 && !sayDone)
        const label = index === 0 ? KIND[card.source] : 'Follow-up'
        const toggle =
          compact && i === 1 ? (
            <button
              onClick={() => setShowOlder(!showOlder)}
              aria-expanded={showOlder}
              className="no-drag mt-3 flex w-full items-center gap-1.5 border-t border-subtle pt-2.5 text-left font-medium text-tertiary hover:text-secondary"
              style={{ fontSize: px(12, scale) }}
            >
              <ChevronRight className={`size-3.5 shrink-0 ${showOlder ? 'rotate-90' : ''}`} />
              {sections.length - 1} earlier
            </button>
          ) : null
        if (hidden) return toggle ? <Fragment key={s.id}>{toggle}</Fragment> : null
        if (!open)
          return (
            <Fragment key={s.id}>
              {toggle}
              <button
                onClick={() => setExpanded({ ...expanded, [s.id]: true })}
                className="no-drag mt-3 flex w-full items-center gap-1.5 border-t border-subtle pt-2.5 text-left text-tertiary hover:text-secondary"
                style={{ fontSize: px(12.5, scale) }}
              >
                <ChevronRight className="size-3.5 shrink-0" />
                <span
                  className="shrink-0 font-semibold tracking-wide uppercase"
                  style={{ fontSize: px(10.5, scale) }}
                >
                  {label}
                </span>
                <span className="min-w-0 truncate">{s.prompt}</span>
              </button>
            </Fragment>
          )
        return (
          <Fragment key={s.id}>
            {toggle}
            <div className={isNewest ? '' : 'mt-3 border-t border-subtle pt-3'}>
              <SectionBody
                section={s}
                label={label}
                scale={scale}
                streaming={isNewest && streaming}
                detailOpen={detailOpen}
                onCollapse={
                  isNewest ? undefined : () => setExpanded({ ...expanded, [s.id]: false })
                }
              />
              {isNewest && carried && (
                <div className="mt-3">
                  <div
                    className="flex items-center gap-1.5 text-tertiary"
                    style={{ fontSize: px(10.5, scale), lineHeight: px(16, scale) }}
                  >
                    <span className="shrink-0 font-semibold tracking-wider uppercase">Code</span>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 truncate font-medium" style={{ fontSize: px(12, scale) }}>
                      from {carried.prompt || 'an earlier answer'}
                    </span>
                  </div>
                  <Detail
                    markdown={carried.detail.match(/^\s*```[\s\S]*?^\s*```/gm)?.join('\n\n') ?? ''}
                    open
                    streaming={false}
                    scale={scale}
                  />
                </div>
              )}
            </div>
          </Fragment>
        )
      })}
      {card.status === 'error' && (
        <p
          className="mt-2 flex items-start gap-2 text-danger"
          style={{ fontSize: px(13.5, scale) }}
        >
          <CircleAlert className="mt-[0.2em] size-[1.05em] shrink-0" />
          <span>{card.error || 'Something went wrong while answering.'}</span>
        </p>
      )}
    </div>
  )
}

function SectionBody({
  section,
  label,
  scale,
  streaming,
  detailOpen,
  onCollapse
}: {
  section: CardSection
  label: string
  scale: number
  streaming: boolean
  detailOpen: boolean
  onCollapse?: () => void
}): ReactNode {
  const { prompt, say, points, detail, deepening } = section
  // Where the soft caret goes: after whatever is currently growing.
  const caretAt =
    deepening && detail
      ? 'detail'
      : !streaming
        ? ''
        : detail
          ? 'detail'
          : points.length
            ? 'points'
            : 'say'
  return (
    <div>
      {/* The label line is always reserved, so the say line never shifts when the prompt arrives. */}
      <div
        className="flex items-center gap-1.5 text-tertiary"
        style={{ fontSize: px(10.5, scale), lineHeight: px(16, scale), minHeight: px(16, scale) }}
        onClick={onCollapse}
      >
        <span className="shrink-0 font-semibold tracking-wider uppercase">{label}</span>
        {prompt && (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-medium" style={{ fontSize: px(12, scale) }}>
              {prompt}
            </span>
          </>
        )}
      </div>
      <p
        className={`mt-1 font-semibold text-default ${caretAt === 'say' ? 'caret' : ''}`}
        style={{ fontSize: px(17, scale), lineHeight: 1.35, letterSpacing: '-0.005em' }}
      >
        {say}
      </p>
      {points.length > 0 && (
        <ul className="mt-2 space-y-1 leading-[1.4]">
          {points.map((p, i) => (
            <li
              key={p.id}
              className={`flex max-w-[60ch] items-start gap-2 ${p.covered ? 'text-tertiary' : 'text-default'}`}
            >
              {p.covered ? (
                <Check
                  className="mt-[0.22em] size-[0.95em] shrink-0 text-accent-text opacity-80"
                  aria-label="Covered"
                />
              ) : (
                <span className="mt-[0.55em] size-[0.36em] shrink-0 rounded-full bg-[var(--color-text-secondary)]" />
              )}
              <span className={caretAt === 'points' && i === points.length - 1 ? 'caret' : ''}>
                {p.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {deepening && !detail && (
        <div className="mt-2.5 text-tertiary" style={{ fontSize: px(12.5, scale) }}>
          <ShimmerText as="span">Adding detail…</ShimmerText>
        </div>
      )}
      {detail && (
        <Detail
          markdown={detail}
          open={detailOpen}
          streaming={caretAt === 'detail'}
          scale={scale}
        />
      )}
    </div>
  )
}

function Detail({
  markdown,
  open: startOpen,
  streaming,
  scale
}: {
  markdown: string
  open: boolean
  streaming: boolean
  scale: number
}): ReactNode {
  const [userOpen, setOpen] = useState(false)
  // code and diagrams are useless clipped to 3 lines: they open fully (the overlay body scrolls)
  const open = startOpen || userOpen || /^\s*```/m.test(markdown)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const deeper = useHotkey('deeper')
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 2)
  }, [markdown, open])
  const lines = 3 * 1.5 * 13.5 * scale
  return (
    <div className="mt-2.5 text-secondary">
      <div
        ref={ref}
        className={`card-md overflow-hidden ${open ? '' : 'clamped'} ${streaming ? 'caret' : ''}`}
        style={{ maxHeight: open ? undefined : `${lines}px`, fontSize: px(13.5, scale) }}
      >
        <Markdown skipHtml copyableCodeBlocks={false}>
          {markdown}
        </Markdown>
      </div>
      {!open && overflows && (
        <button
          onClick={() => setOpen(true)}
          className="no-drag mt-1 flex items-center gap-1.5 font-medium text-secondary hover:text-default"
          style={{ fontSize: px(12, scale) }}
        >
          More
          {deeper && <span className="text-tertiary">· {deeper} goes deeper</span>}
        </button>
      )}
    </div>
  )
}
