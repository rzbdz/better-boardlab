/** shadcn/ui's Tailwind setup: colours from CSS variables (tailwind.css), so light and dark swap in one place. */
const path = require('node:path')
module.exports = {
  darkMode: ['class'],
  content: [path.join(__dirname, '**/*.{ts,tsx,html}')],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      colors: {
        border: 'hsl(var(--border))', input: 'hsl(var(--input))', ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))', foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        ok: 'hsl(var(--ok))', warn: 'hsl(var(--warn))', info: 'hsl(var(--info))',
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', '"WenQuanYi Zen Hei"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: { 'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } }, 'zoom-in': { from: { opacity: '0', transform: 'translate(-50%,-48%) scale(.97)' }, to: { opacity: '1', transform: 'translate(-50%,-50%) scale(1)' } } },
      animation: { 'fade-in': 'fade-in .12s ease-out', 'zoom-in': 'zoom-in .14s ease-out' },
    },
  },
  plugins: [],
}
