/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        /* ── Aunshin · Twilight 60-30-10 ── */
        'aunshin-peach':       '#E1B482',
        'aunshin-peach-light': '#EFD1AF',
        'aunshin-peach-deep':  '#A06343',
        'aunshin-twilight':    '#18090A',
        'aunshin-twilight-2':  '#2A1213',
        'aunshin-sodium':      '#F2B86A',
        'aunshin-sodium-deep': '#D89945',
        'aunshin-rule':        '#C99A78',
        'aunshin-rule-d':      '#5C392B',
        'aunshin-quiet':       '#8A6B58',
        'aunshin-quiet-d':     '#C99A78',

        /* ── Semantic states (brand-neutral) ── */
        'aunshin-success': '#22C55E',
        'aunshin-alert':   '#DC2626',

        /* ── Cockpit CSS-var bridges ── */
        'cp-bg': 'var(--cockpit-bg)',
        'cp-card': 'var(--cockpit-card)',
        'cp-text': 'var(--cockpit-text)',
        'cp-text-secondary': 'var(--cockpit-text-secondary)',
        'cp-text-muted': 'var(--cockpit-text-muted)',
        'cp-border': 'var(--cockpit-card-border)',
      },
      fontFamily: {
        /* Aunshin display + body. */
        'aunshin-display': ['Fraunces', 'Georgia', 'serif'],
        'aunshin-body':    ['Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Berkeley Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        /* Cross-platform parity with iOS NucleusDesignSystem AunshinSpacing.
           Hard-edges rule applies to typography/marks/dividers, not card surfaces. */
        aunshin: '3px',
        'aunshin-lg': '6px',
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
