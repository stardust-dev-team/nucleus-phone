/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'jv-bg': '#0A0A0A',
        'jv-card': 'rgba(20,20,20,0.95)',
        'jv-elevated': 'rgba(30,30,30,0.95)',
        'jv-blue': '#014EFC',
        'jv-green': '#7EC55F',
        'jv-red': '#EF4444',
        'jv-amber': '#F59E0B',
        'jv-border': 'rgba(255,255,255,0.1)',
        'jv-muted': 'rgba(255,255,255,0.6)',
        'cp-bg': 'var(--cockpit-bg)',
        'cp-card': 'var(--cockpit-card)',
        'cp-text': 'var(--cockpit-text)',
        'cp-text-secondary': 'var(--cockpit-text-secondary)',
        'cp-text-muted': 'var(--cockpit-text-muted)',
        'cp-border': 'var(--cockpit-card-border)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
