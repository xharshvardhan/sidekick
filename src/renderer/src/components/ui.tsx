import type { ReactNode } from 'react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { Tooltip } from '@openai/apps-sdk-ui/components/Tooltip'
import type { HotkeyId } from '../../../shared/types'
import { useHotkey } from '../lib'

export function Kbd({ children }: { children: string }): ReactNode {
  if (!children) return null
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center whitespace-nowrap justify-center rounded-xs border border-default bg-surface-secondary px-1 font-sans text-[11px] leading-none font-medium tracking-wide text-secondary">
      {children}
    </kbd>
  )
}

/** Tooltip content: a name plus its hotkey keycap. */
export function TipLabel({ label, hotkey }: { label: string; hotkey?: HotkeyId }): ReactNode {
  const keys = useHotkey(hotkey ?? 'ask')
  return (
    <span className="flex items-center gap-2">
      <span>{label}</span>
      {hotkey && (
        <span className="shrink-0">
          <Kbd>{keys}</Kbd>
        </span>
      )}
    </span>
  )
}

/** Wraps anything in a tooltip; a span wrapper keeps hover working on disabled buttons. */
export function Tip({
  label,
  hotkey,
  children,
  side
}: {
  label: ReactNode
  hotkey?: HotkeyId
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}): ReactNode {
  return (
    <Tooltip
      content={typeof label === 'string' ? <TipLabel label={label} hotkey={hotkey} /> : label}
      maxWidth={300}
      side={side}
    >
      <span className="inline-flex no-drag">{children}</span>
    </Tooltip>
  )
}

export function IconButton({
  label,
  hotkey,
  onClick,
  children,
  disabledReason,
  selected,
  size = 'sm',
  side
}: {
  label: string
  hotkey?: HotkeyId
  onClick: () => void
  children: ReactNode
  /** When set the button is disabled and the tooltip explains why. */
  disabledReason?: string | false
  selected?: boolean
  size?: '2xs' | 'xs' | 'sm' | 'md'
  side?: 'top' | 'bottom' | 'left' | 'right'
}): ReactNode {
  return (
    <Tip
      label={disabledReason ? `${label}: ${disabledReason}` : label}
      hotkey={disabledReason ? undefined : hotkey}
      side={side}
    >
      <Button
        color="secondary"
        variant="ghost"
        size={size}
        uniform
        aria-label={label}
        selected={selected}
        disabled={!!disabledReason}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tip>
  )
}

/** Horizontal meter for Setup and Settings. `level` is 0..1. */
export function LevelMeter({ label, level }: { label: string; level: number }): ReactNode {
  const pct = Math.round(Math.sqrt(Math.min(1, level)) * 100)
  return (
    <div className="flex items-center gap-3">
      <span className="w-10 shrink-0 text-sm text-secondary">{label}</span>
      <div
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--alpha-08)]"
        role="meter"
        aria-label={`${label} level`}
        aria-valuenow={pct}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-100"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** Tiny icon + horizontal bar for the overlay header. */
export function MiniLevel({
  level,
  label,
  icon
}: {
  level: number
  label: string
  icon: ReactNode
}): ReactNode {
  const pct = Math.round(Math.sqrt(Math.min(1, level)) * 100)
  return (
    <Tip label={`${label} level`} side="bottom">
      <span className="flex items-center gap-1 text-tertiary [&_svg]:size-3">
        {icon}
        <span className="relative block h-[3px] w-3.5 overflow-hidden rounded-full bg-[var(--alpha-15)]">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-text-secondary)] transition-[width] duration-100"
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    </Tip>
  )
}

export function LiveDot({ paused }: { paused?: boolean }): ReactNode {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${paused ? 'bg-[var(--color-text-tertiary)]' : 'live-dot bg-accent'}`}
    />
  )
}

/** Page scaffold: a drag strip on top (room for traffic lights handled by the sidebar), title, actions. */
export function Page({
  title,
  subtitle,
  actions,
  children,
  wide
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  wide?: boolean
}): ReactNode {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="drag h-[52px] shrink-0">
        <div
          className={`mx-auto flex h-full items-center gap-3 px-8 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}
        >
          <h1 className="min-w-0 flex-1 heading-sm">
            {/* no-drag only over the text, so the native tooltip for a truncated title can show */}
            <span className="no-drag inline-block max-w-full truncate align-bottom">{title}</span>
          </h1>
          {subtitle && <div className="text-sm whitespace-nowrap text-secondary">{subtitle}</div>}
          {actions && <div className="no-drag flex items-center gap-2">{actions}</div>}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto px-8 pb-10 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>{children}</div>
      </div>
    </div>
  )
}

export function Panel({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <section className={`rounded-xl border border-default bg-surface ${className}`}>
      {children}
    </section>
  )
}
