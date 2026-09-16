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
        scrim: 'rgb(var(--scrim) / <alpha-value>)'
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
