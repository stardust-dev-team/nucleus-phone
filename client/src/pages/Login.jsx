import { useState } from 'react';

const IDENTITIES = ['tom', 'paul', 'kate', 'britt', 'ryann', 'alex'];

export default function Login({ onLogin }) {
  const [identity, setIdentity] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (!identity || !apiKey) {
      setError('Both fields required');
      return;
    }
    onLogin(identity.toLowerCase(), apiKey);
  }

  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <img
        src="https://joruva.com/wp-content/uploads/2024/10/joruva-logo-white.svg"
        alt="Joruva"
        className="h-10 mb-2"
      />
      <h1 className="text-xl font-semibold mb-8">Nucleus Phone</h1>

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div>
          <label className="block text-sm text-jv-muted mb-2">Who are you?</label>
          <div className="grid grid-cols-3 gap-2">
            {IDENTITIES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setIdentity(name)}
                className={`py-2.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                  identity === name
                    ? 'bg-jv-blue text-white'
                    : 'bg-jv-card border border-jv-border text-jv-muted hover:text-white'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm text-jv-muted mb-2">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your API key"
            className="w-full px-4 py-3 rounded-lg bg-jv-card border border-jv-border text-white placeholder-jv-muted focus:outline-none focus:border-jv-blue"
          />
        </div>

        {error && <p className="text-jv-red text-sm">{error}</p>}

        <button
          type="submit"
          className="w-full py-3 rounded-lg bg-jv-blue text-white font-semibold hover:bg-blue-700 transition-colors"
        >
          Connect
        </button>
      </form>

      <p className="text-xs text-jv-muted mt-8">Keep this screen active during calls</p>
    </div>
  );
}
