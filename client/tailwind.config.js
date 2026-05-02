/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        /* ── Aunshin · Twilight 60-30-10 (active brand 2026-05-01) ── */
        'aunshin-peach':       '#E1B482',
        'aunshin-peach-light': '#EFD1AF',
        'aunshin-peach-deep':  '#A06343',
        'aunshin-twilight':    '#2D1F1C',
        'aunshin-twilight-2':  '#4A3631',
        'aunshin-sodium':      '#F2B86A',
        'aunshin-sodium-deep': '#D89945',
        'aunshin-rule':        '#C99A78',
        'aunshin-rule-d':      '#5C392B',
        'aunshin-quiet':       '#8A6B58',
        'aunshin-quiet-d':     '#C99A78',

        /* ── Legacy Sentinel surfaces (cockpit UI; queued for migration to aunshin-* tokens) ── */
        'jv-bg': '#06050F',
        'jv-card': '#0F0D29',
        'jv-elevated': '#1E1B4B',
        'jv-border': 'rgba(49,46,129,0.5)',
        'jv-muted': 'rgba(245,245,244,0.5)',

        /* ── Legacy Sentinel dual-temperature (cockpit UI; queued for migration) ── */
        'jv-amber': '#F59E0B',
        'jv-amber-deep': '#D97706',
        'jv-violet': '#8B5CF6',
        'jv-violet-deep': '#6D28D9',
        'jv-crown': '#4338CA',

        /* ── Semantic states (brand-neutral; keep) ── */
        'jv-green': '#22C55E',
        'jv-red': '#DC2626',
        /* jv-blue legacy alias removed 2026-05-01; consumers migrated to jv-amber (same hex). */

        /* ── Text (legacy Sentinel; queued) ── */
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
        /* Aunshin display + body. Mono retained from Sentinel era. */
        'aunshin-display': ['Fraunces', 'Georgia', 'serif'],
        'aunshin-body':    ['Inter', 'system-ui', 'sans-serif'],
        sans: ['Roboto', 'system-ui', 'sans-serif'],   /* legacy cockpit body — queued for Inter swap */
        mono: ['JetBrains Mono', 'Berkeley Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        aunshin: '0px',   /* hard edges — Aunshin uses sharp corners */
        sentinel: '3px',  /* legacy; cockpit UI still uses */
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
