function HorizonMark({ size = 72 }) {
  return (
    <div
      role="img"
      aria-label="Aunshin"
      className="aunshin-mark aunshin-mark--glow"
      style={{ width: size, height: size }}
    />
  );
}

export default function Login() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full px-6"
      style={{ background: 'var(--color-aunshin-twilight)' }}
    >
      <HorizonMark />

      <h1
        className="aunshin-display mt-6 mb-1"
        style={{
          color: 'var(--color-aunshin-peach-light)',
          fontSize: '3rem',
          lineHeight: 1,
        }}
      >
        aunshin
      </h1>
      <div
        className="h-[1.5px] w-24 mb-2"
        style={{ background: 'var(--color-aunshin-peach)', opacity: 0.6 }}
      />
      <p
        className="text-[11px] tracking-[3px] uppercase mb-8"
        style={{ color: 'var(--color-aunshin-quiet-d)', fontFamily: 'JetBrains Mono, monospace' }}
      >
        Phone
      </p>

      <a
        href="/api/auth/login"
        className="aunshin-sso-primary w-full max-w-sm flex items-center justify-center gap-3 py-3 font-semibold text-sm uppercase"
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '12px',
          letterSpacing: '0.18em',
        }}
      >
        <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
          <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
          <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
          <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
        </svg>
        Sign in with Microsoft
      </a>

      <p
        className="text-[11px] mt-8"
        style={{ color: 'var(--color-aunshin-quiet-d)', fontFamily: 'JetBrains Mono, monospace' }}
      >
        Use your @joruva.com account
      </p>
    </div>
  );
}
