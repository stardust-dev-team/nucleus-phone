const CATEGORY_COLORS = {
  APPROACH: {
    bg: 'var(--cockpit-blue-50)',
    accent: 'var(--cockpit-blue-500)',
    text: 'var(--cockpit-blue-900)',
  },
  'WATCH OUT': {
    bg: 'var(--cockpit-orange-50)',
    accent: 'var(--cockpit-orange-500)',
    text: 'var(--cockpit-orange-900)',
  },
  OPPORTUNITY: {
    bg: 'var(--cockpit-green-50)',
    accent: 'var(--cockpit-green-500)',
    text: 'var(--cockpit-green-900)',
  },
  CONTEXT: {
    bg: 'var(--cockpit-gray-50)',
    accent: 'var(--cockpit-text-muted)',
    text: 'var(--cockpit-text)',
  },
};

function categorize(text) {
  const lower = (text || '').toLowerCase();
  if (/\b(opportunity|potential|upgrade)\b/.test(lower))
    return 'OPPORTUNITY';
  if (/\b(watch out|caution|risk|warning)\b/.test(lower))
    return 'WATCH OUT';
  return 'APPROACH';
}

export default function IntelNuggets({ nuggets, watchOuts }) {
  const items = [];

  if (nuggets?.length) {
    nuggets.forEach(n => {
      if (typeof n === 'object' && n.category) {
        items.push(n);
      } else {
        const text = typeof n === 'string' ? n : n.text || String(n);
        items.push({ category: categorize(text), headline: text, body: '' });
      }
    });
  }

  if (watchOuts?.length) {
    watchOuts.forEach(w => {
      const text = typeof w === 'string' ? w : w.text || String(w);
      items.push({ category: 'WATCH OUT', headline: text, body: '' });
    });
  }

  if (!items.length) return null;

  return (
    <div className="mb-5 min-w-0">
      <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-wider mb-2">
        Intelligence nuggets
      </div>
      <div
        className="flex gap-2.5 overflow-x-auto pb-1"
        style={{
          maskImage: 'linear-gradient(to right, black 85%, transparent)',
          WebkitMaskImage: 'linear-gradient(to right, black 85%, transparent)',
        }}
      >
        {items.map((n, i) => {
          const c = CATEGORY_COLORS[n.category] || CATEGORY_COLORS.APPROACH;
          return (
            <div
              key={i}
              className="min-w-[200px] flex-[1_0_200px] rounded-lg py-3 px-3.5 transition-colors duration-300"
              style={{
                background: c.bg,
                borderTop: `3px solid ${c.accent}`,
              }}
            >
              <div
                className="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: c.accent }}
              >
                {n.category}
              </div>
              <div className="text-[13px] font-medium leading-[1.3] mb-1" style={{ color: c.text }}>
                {n.headline}
              </div>
              {n.body && (
                <div className="text-xs text-cp-text-secondary leading-[1.4]">{n.body}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
