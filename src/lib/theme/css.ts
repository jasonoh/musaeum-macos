import type { GoldStep, InkStep, StatusFamily, ThemeTokens } from '@shared/theme.types'

/**
 * The apply path, pure and injectable.
 *
 * The renderer writes the palette onto `document.documentElement` before its
 * first render (`src/main.tsx`), and again whenever main says the theme changed
 * (`src/hooks/useTheme.ts`). Both call `applyTokens`, which decides every custom
 * property a token set owns, reconciles the ones a previous set owned, and
 * **returns a reason instead of throwing** — so "what the app renders" is a
 * value that can be asserted without a DOM (there is no `document` in the vitest
 * environment; both take the element they write to for exactly that reason).
 *
 * **The channel triplet is load-bearing.** `tailwind.config.js` composes every
 * colour as `rgb(var(--x) / <alpha-value>)`, and `rgb()` over a `#hex` value is
 * invalid at computed-value time: every opacity-modified utility
 * (`bg-ink-950/80`, `bg-gold-500/40`, …) is then dropped silently, with the
 * build still green. So a hex reaching `documentElement.style` is a defect, and
 * `tokensToCssVars` emits `13 11 9`, never `#0d0b09`.
 */

const INK_STEPS: readonly InkStep[] = ['950', '900', '850', '800', '700', '600', '500']
const GOLD_STEPS: readonly GoldStep[] = ['300', '400', '500', '600']
/** The token set's own spelling is snake_case; the CSS property is not. */
const PARCHMENT_STOPS = [
  ['parchment', '--parchment'],
  ['parchment_dim', '--parchment-dim'],
  ['parchment_faint', '--parchment-faint']
] as const
const STATUS_FAMILIES: readonly StatusFamily[] = ['danger', 'ok', 'warn']
const STATUS_STEPS = ['400', '500', '600', 'on'] as const

/**
 * A `#rrggbb` colour → the space-separated channel triplet Tailwind composes
 * (`'#0d0b09'` → `'13 11 9'`).
 *
 * It throws on anything else rather than writing a hex through: the caller that
 * hands this a value it cannot use is the one that should be loud, and main
 * validates every stored colour against `^#[0-9a-f]{6}$` before it is ever sent,
 * so reaching this throw means a caller bypassed that validation.
 */
export function hexToChannels(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Not a #rrggbb colour: ${JSON.stringify(hex)}`)
  }
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  return channels.join(' ')
}

/**
 * Every custom property this path owns.
 *
 * Ownership is *fixed and total*, not "whatever this set decides": a switch is
 * only a switch if the previous set's properties can be taken away again, and
 * `setProperty` alone can only add. The names are the 16 colours (7 ink + 3
 * parchment + 4 gold + on-accent + scrim) plus slice 7a's twelve
 * `--status-<family>-<step>` — frozen by A28 — which are owned even by a set
 * that carries no status family, because the *previous* set may have carried
 * one. `--shadow-a1/a2/a3` and `color-scheme` are deliberately absent: slice 5
 * owns them and `:root` keeps its authored values until then.
 */
export const OWNED_CSS_VARS: readonly string[] = [
  ...INK_STEPS.map((step) => `--ink-${step}`),
  ...PARCHMENT_STOPS.map(([, property]) => property),
  ...GOLD_STEPS.map((step) => `--gold-${step}`),
  '--on-accent',
  '--scrim',
  ...STATUS_FAMILIES.flatMap((family) => STATUS_STEPS.map((step) => `--status-${family}-${step}`))
]

/**
 * Every custom property this token set decides. Pure; no DOM.
 *
 * `--shadow-a1/a2/a3` and `color-scheme` are **not** here: slice 5 owns them
 * (`:root` keeps its authored alphas and its declared scheme until then), and
 * so is slice 7a's status block in `:root` — this writes `--status-*` only when
 * the *set* carries a status family, which the built-in default does not.
 *
 * A property it does not decide is not necessarily left alone: `applyTokens`
 * reconciles against `OWNED_CSS_VARS`, so what this omits is what that removes.
 */
export function tokensToCssVars(tokens: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const step of INK_STEPS) vars[`--ink-${step}`] = hexToChannels(tokens.ink[step])
  for (const [key, property] of PARCHMENT_STOPS)
    vars[property] = hexToChannels(tokens.parchment[key])
  for (const step of GOLD_STEPS) vars[`--gold-${step}`] = hexToChannels(tokens.gold[step])
  vars['--on-accent'] = hexToChannels(tokens.on_acc)
  vars['--scrim'] = hexToChannels(tokens.scrim)

  const { status } = tokens
  if (status) {
    for (const family of STATUS_FAMILIES) {
      for (const step of STATUS_STEPS) {
        vars[`--status-${family}-${step}`] = hexToChannels(status[family][step])
      }
    }
  }
  return vars
}

/** The slice of a DOM element this needs — `document.documentElement` fits it. */
export interface CssVarTarget {
  style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): void
  }
}

/**
 * Writes `tokensToCssVars`' result onto `el`, defaulting to the document root —
 * takes away every property this path owns that the set does not decide, and
 * **never throws**: `null` when it wrote, or the reason it could not.
 *
 * *Why it does not throw.* Both call sites are on the renderer's boot path, and
 * `hexToChannels` is the loud end of the validation contract. The two sites had
 * drifted: `src/main.tsx` wrapped its read-and-apply in a `try`/`catch` and
 * rendered either way, while `src/hooks/useTheme.ts` applied in an effect with
 * no guard, so a throw there propagated into React and unmounted the tree. A
 * guard one caller remembers is not a guard. Reporting the failure as a value
 * instead is also this repo's shape everywhere else a theme can fail
 * (`CLAUDE.md` #12 — the app keeps the palette it already had, and the reason is
 * logged by whoever has somewhere to log it). Nothing is written when it cannot
 * write: the plan is built before the element is touched, so a refused apply
 * leaves the previous theme standing rather than half a palette.
 *
 * *Why it removes.* Every built-in's derived tokens carry a status family and
 * the built-in default does not (`:root` has no status block until 7a), so a
 * picker moving back to the default would otherwise leave twelve stale
 * `--status-*` properties on `documentElement` — silently, with nothing
 * consuming them until 7a and no test able to see it. It is deliberately *only*
 * the owned names: `--shadow-a1/a2/a3` and `color-scheme` keep whatever
 * `src/index.css` declares.
 */
export function applyTokens(
  tokens: ThemeTokens,
  el: CssVarTarget = document.documentElement
): string | null {
  let write: Record<string, string>
  try {
    write = tokensToCssVars(tokens)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  try {
    for (const name of OWNED_CSS_VARS) {
      // `Object.hasOwn` for the same reason `store.ts`'s registry uses it: these
      // names cannot collide with an inherited key today, and the rule that keeps
      // them from starting to is cheaper than the failure it prevents.
      if (!Object.hasOwn(write, name)) el.style.removeProperty(name)
    }
    for (const [name, value] of Object.entries(write)) {
      el.style.setProperty(name, value)
    }
  } catch (err) {
    // The plan is already built, so a DOM that refuses a write (an invalid
    // property name, a detached document) is reported rather than thrown — the
    // one thing this path may never do is take the renderer down with it.
    return err instanceof Error ? err.message : String(err)
  }
  return null
}
