function HorizonMark({ size = 64 }) {
  return (
    <div
      role="img"
      aria-label="Aunshin"
      style={{
        position: 'relative',
        width: size,
        height: size,
        background: 'var(--color-aunshin-twilight)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '42%',
          left: '50%',
          width: '18.75%',
          height: '18.75%',
          borderRadius: '50%',
          background: 'var(--color-aunshin-sodium)',
          transform: 'translate(-50%, -50%)',
          boxShadow: '0 0 18px rgba(242, 184, 106, 0.5)',
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: '68%',
          left: '50%',
          width: '58%',
          height: 1.5,
          background: 'var(--color-aunshin-peach)',
          opacity: 0.7,
          transform: 'translateX(-50%)',
        }}
      />
    </div>
  );
}

export default function Login() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full px-6"
      style={{ background: 'var(--color-aunshin-twilight)' }}
    >
      <HorizonMark size={72} />

      <h1
        className="mt-6 mb-1"
        style={{
          color: 'var(--color-aunshin-peach-light)',
          fontFamily: 'Fraunces, Georgia, serif',
          fontWeight: 300,
          fontSize: '3rem',
          fontVariationSettings: '"opsz" 144, "SOFT" 100',
          letterSpacing: '-0.04em',
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
        className="w-full max-w-sm flex items-center justify-center gap-3 py-3 font-semibold text-sm uppercase tracking-wider transition-colors"
        style={{
          background: 'var(--color-aunshin-sodium)',
          color: 'var(--color-aunshin-twilight)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '12px',
          letterSpacing: '0.18em',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-aunshin-sodium-deep)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-aunshin-sodium)'; }}
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
