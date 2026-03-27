export default function Login() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <img
        src="https://joruva.com/wp-content/uploads/2024/10/joruva-logo-white.svg"
        alt="Joruva"
        className="h-10 mb-2"
      />
      <h1 className="text-xl font-semibold mb-8">Nucleus Phone</h1>

      <a
        href="/api/auth/login"
        className="w-full max-w-sm flex items-center justify-center gap-3 py-3 rounded-lg bg-jv-blue text-white font-semibold hover:bg-blue-700 transition-colors"
      >
        <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
          <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
          <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
          <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
        </svg>
        Sign in with Microsoft
      </a>

      <p className="text-xs text-jv-muted mt-8">Use your @joruva.com account</p>
    </div>
  );
}
