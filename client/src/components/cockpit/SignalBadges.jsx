import { useState, useEffect } from 'react';

const TIER_STYLES = {
  spear: { bg: 'var(--cockpit-red-bg)', color: 'var(--cockpit-red-text)', label: 'SPEAR' },
  targeted: { bg: 'var(--cockpit-amber-50)', color: 'var(--cockpit-amber-900)', label: 'TARGETED' },
  awareness: { bg: 'var(--cockpit-gray-100)', color: 'var(--cockpit-text-muted)', label: 'AWARENESS' },
};

function formatMonths(dateStr) {
  if (!dateStr) return null;
  const expiry = new Date(dateStr);
  if (isNaN(expiry.getTime())) return null;
  const now = new Date();
  const months = (expiry.getFullYear() - now.getFullYear()) * 12 +
    (expiry.getMonth() - now.getMonth());
  if (months < 0) return 'EXPIRED';
  return months;
}

function formatCurrency(amount) {
  if (!amount) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(amount);
}

export default function SignalBadges({ domain, signalMetadata }) {
  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(false);

  // Use prop when available (cockpit already fetched it), otherwise self-fetch
  useEffect(() => {
    if (signalMetadata || !domain) return;
    setLoading(true);
    fetch(`/api/signals/${encodeURIComponent(domain)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setFetched(d?.signal_metadata || null))
      .catch(() => setFetched(null))
      .finally(() => setLoading(false));
  }, [domain, signalMetadata]);

  const meta = signalMetadata || fetched;

  if (!meta && loading) return <div className="signal-badges loading">Loading signals...</div>;
  if (!meta) return null;
  const tierStyle = TIER_STYLES[meta.signal_tier] || TIER_STYLES.awareness;
  const badges = [];

  // Tier badge
  badges.push(
    <span key="tier" className="signal-badge tier" style={{
      background: tierStyle.bg, color: tierStyle.color,
      padding: '2px 8px', borderRadius: '3px', fontWeight: '600', fontSize: '11px',
      letterSpacing: '1.5px',
    }}>
      {tierStyle.label}{meta.signal_score != null ? ` · Score ${meta.signal_score}` : ''}
    </span>
  );

  // Cert expiry badge
  if (meta.cert_expiry_date) {
    const months = formatMonths(meta.cert_expiry_date);
    const expired = months === 'EXPIRED';
    const urgent = expired || (months !== null && months <= 9);
    badges.push(
      <span key="cert" className="signal-badge cert" style={{
        background: urgent ? 'var(--cockpit-red-bg)' : 'var(--cockpit-amber-50)',
        color: urgent ? 'var(--cockpit-red-text)' : 'var(--cockpit-amber-900)',
        padding: '2px 8px', borderRadius: '3px', fontSize: '12px',
        border: `1px solid ${urgent ? 'var(--cockpit-red-text)' : 'var(--cockpit-amber-100)'}`,
        opacity: 0.85,
      }}>
        {meta.cert_standard || 'AS9100'} {expired ? 'EXPIRED' : `expires ${months !== null ? `${months}mo` : meta.cert_expiry_date}`}
        {meta.cert_body ? ` — ${meta.cert_body}` : ''}
      </span>
    );
  }

  // Contract badge
  if (meta.contract_total) {
    badges.push(
      <span key="contract" className="signal-badge contract" style={{
        background: meta.dod_flag ? 'var(--cockpit-blue-50)' : 'var(--cockpit-green-50)',
        color: meta.dod_flag ? 'var(--cockpit-blue-900)' : 'var(--cockpit-green-900)',
        padding: '2px 8px', borderRadius: '3px', fontSize: '12px',
        border: `1px solid ${meta.dod_flag ? 'var(--cockpit-blue-border)' : 'var(--cockpit-green-500-20)'}`,
      }}>
        {meta.dod_flag ? 'DoD' : 'Govt'} contract {formatCurrency(meta.contract_total)}
      </span>
    );
  }

  // Multi-source badge
  if (meta.source_count > 1) {
    badges.push(
      <span key="multi" className="signal-badge multi" style={{
        background: 'var(--cockpit-purple-50)', color: 'var(--cockpit-purple-900)',
        padding: '2px 8px', borderRadius: '3px', fontSize: '12px',
        border: '1px solid var(--cockpit-purple-border)',
      }}>
        {meta.source_count}x MATCH
      </span>
    );
  }

  return (
    <div className="signal-badges" style={{
      display: 'flex', flexWrap: 'wrap', gap: '6px',
      padding: '8px 0', marginBottom: '8px',
    }}>
      {badges}
    </div>
  );
}
