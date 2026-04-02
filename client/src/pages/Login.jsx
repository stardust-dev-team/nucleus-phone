function SentinelMark({ size = 48 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width={size} height={size}>
      <defs>
        <linearGradient id="lpFace" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1E1B4B"/><stop offset="50%" stopColor="#0F0D29"/><stop offset="100%" stopColor="#06050F"/>
        </linearGradient>
        <linearGradient id="lpSlit" x1="0%" y1="50%" x2="100%" y2="50%">
          <stop offset="0%" stopColor="#F97316"/><stop offset="100%" stopColor="#DC2626"/>
        </linearGradient>
        <filter id="lpGlow"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <rect x="72" y="32" width="56" height="136" rx="2" fill="url(#lpFace)"/>
      <rect x="82" y="92" width="36" height="3" rx="1.5" fill="url(#lpSlit)" filter="url(#lpGlow)"/>
    </svg>
  );
}

export default function Login() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6" style={{ background: '#06050F' }}>
      <SentinelMark size={64} />

      <h1 className="text-2xl font-black tracking-[4px] mt-4 mb-1" style={{ color: '#F5F5F4' }}>
        NUCLEUS
      </h1>
      <div className="h-[2px] w-24 rounded-full mb-1 sentinel-slit" />
      <p className="text-[11px] tracking-[3px] uppercase mb-8" style={{ color: '#78716C' }}>
        Phone
      </p>

      <a
        href="/api/auth/login"
        className="w-full max-w-sm flex items-center justify-center gap-3 py-3 font-semibold text-sm uppercase tracking-wider transition-all"
        style={{ background: '#F59E0B', color: '#000', borderRadius: '3px' }}
      >
        <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
          <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
          <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
          <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
        </svg>
        Sign in with Microsoft
      </a>

      <p className="text-[11px] mt-8" style={{ color: '#78716C' }}>
        Use your @joruva.com account
      </p>
    </div>
  );
}
