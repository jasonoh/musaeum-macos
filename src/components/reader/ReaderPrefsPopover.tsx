import type { ReactNode } from 'react'
import { TITLEBAR_STRIP_HEIGHT } from '@shared/window-chrome'
import type { ReaderPageTheme } from '@/lib/theme/reader-palette'
import { PREF_RANGES, THEME_OPTIONS, TYPEFACE_OPTIONS, useReaderStore } from '@/stores/reader.store'

/**
 * Where the panel floats: just under the reader's titlebar strip, keeping the
 * 4px of daylight the old `top-12` (44 + 4) left now that the strip is derived
 * from the lights' line and therefore taller (`TITLEBAR_STRIP_HEIGHT`).
 */
const POPOVER_TOP = TITLEBAR_STRIP_HEIGHT + 4

/**
 * Typography controls for the open book.
 *
 * The settings are per-machine, not per-book — they describe the reader, not
 * the text — so they live in the reader store's persisted `prefs` and every
 * change restyles the page in place (the engine re-injects its stylesheet;
 * nothing re-opens).
 *
 * It floats inside the reader's own layer rather than over the whole app: the
 * backdrop is transparent and click-to-dismiss, so the page stays visible
 * while it is being adjusted — the point of the panel is watching the text
 * change.
 */
export function ReaderPrefsPopover({ onClose }: { onClose: () => void }) {
  const prefs = useReaderStore((s) => s.prefs)
  const setPrefs = useReaderStore((s) => s.setPrefs)

  return (
    <div className="fixed inset-0 z-10" onClick={onClose} onContextMenu={onClose}>
      <div
        role="dialog"
        aria-label="Typography"
        onClick={(e) => e.stopPropagation()}
        className="absolute right-2 w-64 animate-slide-up space-y-4 rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-cover-lift"
        style={{ top: POPOVER_TOP }}
      >
        <Segmented
          label="Typeface"
          options={TYPEFACE_OPTIONS}
          value={prefs.typeface}
          onChange={(typeface) => setPrefs({ typeface })}
          renderOption={(o) => (
            <span className={o.value === 'serif' ? 'font-display' : 'font-body'}>{o.label}</span>
          )}
        />
        <Segmented
          label="Theme"
          options={THEME_OPTIONS}
          value={prefs.theme}
          onChange={(theme) => setPrefs({ theme })}
          renderOption={(o) => (
            <>
              <ThemeDot theme={o.value} />
              {o.label}
            </>
          )}
        />

        <div className="space-y-3 border-t border-ink-800 pt-3">
          <Slider
            label="Size"
            {...PREF_RANGES.fontSize}
            value={prefs.fontSize}
            readout={`${prefs.fontSize}px`}
            onChange={(fontSize) => setPrefs({ fontSize })}
          />
          <Slider
            label="Line height"
            {...PREF_RANGES.lineHeight}
            value={prefs.lineHeight}
            readout={prefs.lineHeight.toFixed(1)}
            onChange={(lineHeight) => setPrefs({ lineHeight })}
          />
          {/* "Spacing", not "Margin": foliate spends this on page inset and
              column gutter, so the left text edge never moves. The stored
              field, the range key and the paginator attribute all stay
              `margin` — only the promise made to the reader changes. */}
          <Slider
            label="Spacing"
            {...PREF_RANGES.margin}
            value={prefs.margin}
            readout={`${prefs.margin}px`}
            onChange={(margin) => setPrefs({ margin })}
          />
        </div>
      </div>
    </div>
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-widest text-parchment-faint">
      {children}
    </span>
  )
}

/**
 * The dot beside a theme option, in the palette the option actually paints.
 *
 * The third option is **two-tone** — ink over parchment — because `auto` is not
 * either row: it is whichever row the app theme resolves to, and the old
 * two-way branch (`ink` ? ink : parchment) would have drawn it as a second
 * `paper`. No new colour is introduced for it: both halves are existing tokens,
 * which is the rule that keeps the dot meaningful under any imported theme.
 */
function ThemeDot({ theme }: { theme: ReaderPageTheme }) {
  if (theme !== 'auto') {
    return (
      <span
        aria-hidden
        className={`h-2.5 w-2.5 rounded-full border border-ink-600 ${
          theme === 'ink' ? 'bg-ink-950' : 'bg-parchment'
        }`}
      />
    )
  }
  return (
    <span
      aria-hidden
      className="flex h-2.5 w-2.5 flex-col overflow-hidden rounded-full border border-ink-600"
    >
      <span className="h-1/2 w-full bg-ink-950" />
      <span className="h-1/2 w-full bg-parchment" />
    </span>
  )
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  renderOption
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  renderOption?: (option: { value: T; label: string }) => ReactNode
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="mt-1.5 flex gap-0.5 rounded-md border border-ink-700 bg-ink-850 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-[12px] transition-colors ${
              value === o.value
                ? 'bg-ink-700 text-gold-300'
                : 'text-parchment-dim hover:text-parchment'
            }`}
          >
            {renderOption ? renderOption(o) : o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  readout,
  onChange
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  readout: string
  onChange: (value: number) => void
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <FieldLabel>{label}</FieldLabel>
        <span className="text-[11px] tabular-nums text-parchment-dim">{readout}</span>
      </span>
      {/* Native rendering, tinted: `appearance-none` would take the thumb with
          it and nothing here redraws one */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full cursor-pointer accent-gold-500"
      />
    </label>
  )
}
