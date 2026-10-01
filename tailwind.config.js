/** @type {import('tailwindcss').Config} */

/*
 * The palette is not compiled in any more. Every token resolves through a CSS custom
 * property holding space-separated sRGB channels, whose default lives in `src/index.css`.
 * The `rgb(var(--x) / <alpha-value>)` form is mandatory, not stylistic: `rgb(var(--x))`
 * over a hex-valued property is invalid at computed-value time, so every
 * opacity-modified utility (`bg-gold-500/40`, `bg-ink-950/80`, …) would be dropped
 * silently, with the build still green.
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm near-black surfaces — "private reading room at night"
        ink: {
          950: 'rgb(var(--ink-950) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          850: 'rgb(var(--ink-850) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)'
        },
        // Warm off-white text tones
        parchment: {
          DEFAULT: 'rgb(var(--parchment) / <alpha-value>)',
          dim: 'rgb(var(--parchment-dim) / <alpha-value>)',
          faint: 'rgb(var(--parchment-faint) / <alpha-value>)'
        },
        // Amber/gold accent
        gold: {
          300: 'rgb(var(--gold-300) / <alpha-value>)',
          400: 'rgb(var(--gold-400) / <alpha-value>)',
          500: 'rgb(var(--gold-500) / <alpha-value>)',
          600: 'rgb(var(--gold-600) / <alpha-value>)'
        },
        // A role, not a ramp step: the veil that *darkens* whatever is behind it
        scrim: 'rgb(var(--scrim) / <alpha-value>)',
        /*
         * The status family (slice 7a). `400` is the text step, `500` is the fill
         * that carries the `on-*` foreground, and `600` is a deeper fill with no
         * derived foreground — a filled danger surface uses `500` (annex D2),
         * because `on-danger` is only floored against it. The names are frozen
         * (A28) and the values are `:root`'s, derived from the app's own palette.
         */
        danger: {
          400: 'rgb(var(--status-danger-400) / <alpha-value>)',
          500: 'rgb(var(--status-danger-500) / <alpha-value>)',
          600: 'rgb(var(--status-danger-600) / <alpha-value>)'
        },
        ok: {
          400: 'rgb(var(--status-ok-400) / <alpha-value>)',
          500: 'rgb(var(--status-ok-500) / <alpha-value>)',
          600: 'rgb(var(--status-ok-600) / <alpha-value>)'
        },
        warn: {
          400: 'rgb(var(--status-warn-400) / <alpha-value>)',
          500: 'rgb(var(--status-warn-500) / <alpha-value>)',
          600: 'rgb(var(--status-warn-600) / <alpha-value>)'
        },
        // Each family's filled-surface foreground — a role, not a ramp step, and
        // only ever audited against that family's `500`.
        'on-danger': 'rgb(var(--status-danger-on) / <alpha-value>)',
        'on-ok': 'rgb(var(--status-ok-on) / <alpha-value>)',
        'on-warn': 'rgb(var(--status-warn-on) / <alpha-value>)'
      },
      fontFamily: {
        display: ['"Iowan Old Style"', 'Palatino', '"Palatino Linotype"', 'Georgia', 'serif'],
        body: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          'sans-serif'
        ]
      },
      boxShadow: {
        cover: '0 2px 8px rgb(0 0 0 / var(--shadow-a1)), 0 8px 24px rgb(0 0 0 / var(--shadow-a2))',
        // The grid cover's open state: the rest shadow thrown down and to the
        // right, as the fore edge it belongs to swings toward the reader.
        'cover-open':
          '1px 3px 6px rgb(0 0 0 / var(--shadow-a2)), 10px 14px 28px -6px rgb(0 0 0 / var(--shadow-a1))',
        'cover-lift':
          '0 4px 12px rgb(0 0 0 / var(--shadow-a3)), 0 16px 40px rgb(0 0 0 / var(--shadow-a1))',
        panel: '-8px 0 32px rgb(0 0 0 / var(--shadow-a1))'
      },
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'slide-in-right': 'slideInRight 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)'
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        slideInRight: {
          from: { transform: 'translateX(24px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' }
        },
        slideUp: {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' }
        }
      }
    }
  },
  plugins: []
}
