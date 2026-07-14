/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm near-black surfaces — "private reading room at night"
        ink: {
          950: '#0d0b09',
          900: '#14110d',
          850: '#191511',
          800: '#201b15',
          700: '#2b241c',
          600: '#3b3226',
          500: '#4f4433'
        },
        // Warm off-white text tones
        parchment: {
          DEFAULT: '#e9e1d2',
          dim: '#b3a78f',
          faint: '#7d7260'
        },
        // Amber/gold accent
        gold: {
          300: '#e8c987',
          400: '#d4a24e',
          500: '#c08f3a',
          600: '#9c7028'
        }
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
        cover: '0 2px 8px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.35)',
        'cover-lift': '0 4px 12px rgba(0,0,0,0.6), 0 16px 40px rgba(0,0,0,0.5)',
        panel: '-8px 0 32px rgba(0,0,0,0.5)'
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
