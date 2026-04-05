/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        /* ── Sentinel surfaces ── */
        'jv-bg': '#06050F',
        'jv-card': '#0F0D29',
        'jv-elevated': '#1E1B4B',
        'jv-border': 'rgba(49,46,129,0.5)',
        'jv-muted': 'rgba(245,245,244,0.5)',

        /* ── Sentinel dual-temperature ── */
        'jv-amber': '#F59E0B',
        'jv-amber-deep': '#D97706',
        'jv-violet': '#8B5CF6',
        'jv-violet-deep': '#6D28D9',
        'jv-crown': '#4338CA',

        /* ── Semantic states ── */
        'jv-green': '#22C55E',
        'jv-red': '#DC2626',
        'jv-blue': '#F59E0B',  /* Legacy alias → amber (prevents broken references) */

        /* ── Text ── */
        'jv-bone': '#F5F5F4',
        'jv-pewter': '#78716C',

        /* ── Cockpit CSS-var bridges ── */
        'cp-bg': 'var(--cockpit-bg)',
        'cp-card': 'var(--cockpit-card)',
        'cp-text': 'var(--cockpit-text)',
        'cp-text-secondary': 'var(--cockpit-text-secondary)',
        'cp-text-muted': 'var(--cockpit-text-muted)',
        'cp-border': 'var(--cockpit-card-border)',
      },
      fontFamily: {
        sans: ['Roboto', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Berkeley Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        sentinel: '3px',
      },
    },
  },
  plugins: [
    function({ addVariant }) {
      addVariant('radix-open', '&[data-state="open"]');
      addVariant('radix-closed', '&[data-state="closed"]');
    },
  ],
};
