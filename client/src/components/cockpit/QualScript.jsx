import { useState, useMemo, useEffect, useRef } from 'react';

const DEFAULT_ITEMS = [
  'Verify role & decision authority',
  'Current air system — brand, HP, age?',
  'Pain points — downtime, moisture, energy costs?',
  'CFM requirements — how many machines running?',
  'Timeline — when looking to act?',
  'Budget range & financing interest?',
];

function parseScript(adaptedScript) {
  if (!adaptedScript) return DEFAULT_ITEMS;
  if (Array.isArray(adaptedScript)) return adaptedScript.length >= 3 ? adaptedScript : DEFAULT_ITEMS;

  const lines = String(adaptedScript)
    .split(/\n/)
    .map(line => line.replace(/^[\d]+[.)]\s*|^[-•*]\s*/, '').trim())
    .filter(Boolean);

  return lines.length >= 3 ? lines : DEFAULT_ITEMS;
}

export default function QualScript({ adaptedScript }) {
  const items = useMemo(() => parseScript(adaptedScript), [adaptedScript]);
  const prevItemsRef = useRef(items);
  const [checks, setChecks] = useState(() => items.reduce((a, _, i) => ({ ...a, [i]: false }), {}));

  useEffect(() => {
    const prev = prevItemsRef.current;
    if (prev.length !== items.length || prev.some((v, i) => v !== items[i])) {
      setChecks(items.reduce((a, _, i) => ({ ...a, [i]: false }), {}));
      prevItemsRef.current = items;
    }
  }, [items]);

  const done = Object.values(checks).filter(Boolean).length;
  const total = items.length;

  return (
    <div className="mb-2">
      <div className="text-[10px] font-semibold text-cp-text-muted uppercase tracking-wider mb-1">
        Qual script — {done}/{total}
      </div>
      <div
        className="rounded-lg py-2 px-3 transition-colors duration-300 bg-cp-card border border-cp-border"
      >
        <div className="h-1 rounded-sm mb-2" style={{ background: 'var(--cockpit-gray-100)' }}>
          <div
            className="h-1 rounded-sm transition-all duration-300 ease-out"
            style={{
              background: 'var(--cockpit-check-accent)',
              width: `${total > 0 ? (done / total) * 100 : 0}%`,
            }}
          />
        </div>

        {items.map((text, i) => (
          <label
            key={i}
            className="flex items-start gap-2 py-1.5 cursor-pointer"
            style={{ borderBottom: i < items.length - 1 ? '1px solid var(--cockpit-card-border)' : 'none' }}
          >
            <input
              type="checkbox"
              checked={checks[i] || false}
              onChange={() => setChecks(p => ({ ...p, [i]: !p[i] }))}
              className="mt-0.5 w-3.5 h-3.5 shrink-0"
              style={{ accentColor: 'var(--cockpit-check-accent)' }}
            />
            <span
              className="text-[13px] leading-snug transition-colors duration-200"
              style={{
                color: checks[i] ? 'var(--cockpit-text-muted)' : 'var(--cockpit-text)',
                textDecoration: checks[i] ? 'line-through' : 'none',
              }}
            >
              {text}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
