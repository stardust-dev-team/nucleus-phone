import { useState, useEffect } from 'react';

const TIER_STYLES = {
  spear: { bg: '#dc2626', color: '#fff', label: 'SPEAR' },
  targeted: { bg: '#f59e0b', color: '#000', label: 'TARGETED' },
  awareness: { bg: '#6b7280', color: '#fff', label: 'AWARENESS' },
};

function formatMonths(dateStr) {
  if (!dateStr) return null;
  const expiry = new Date(dateStr);
  const now = new Date();
  const months = (expiry.getFullYear() - now.getFullYear()) * 12 +
    (expiry.getMonth() - now.getMonth());
  return months;
}

function formatCurrency(amount) {
  if (!amount) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(amount);
}

export default function SignalBadges({ domain }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!domain) return;
    setLoading(true);
    fetch(`/api/signals/${encodeURIComponent(domain)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [domain]);

  if (loading) return <div className="signal-badges loading">Loading signals...</div>;
  if (!data?.signal_metadata) return null;

  const meta = data.signal_metadata;
  const tierStyle = TIER_STYLES[meta.signal_tier] || TIER_STYLES.awareness;
  const badges = [];

  // Tier badge
  badges.push(
    <span key="tier" className="signal-badge tier" style={{
      background: tierStyle.bg, color: tierStyle.color,
      padding: '2px 8px', borderRadius: '4px', fontWeight: 'bold', fontSize: '11px',
    }}>
      {tierStyle.label} · Score {meta.signal_score}
    </span>
  );

  // Cert expiry badge
  if (meta.cert_expiry_date) {
    const months = formatMonths(meta.cert_expiry_date);
    const urgent = months !== null && months <= 9;
    badges.push(
      <span key="cert" className="signal-badge cert" style={{
        background: urgent ? '#fef2f2' : '#fffbeb',
        color: urgent ? '#991b1b' : '#92400e',
        padding: '2px 8px', borderRadius: '4px', fontSize: '12px',
        border: `1px solid ${urgent ? '#fca5a5' : '#fcd34d'}`,
      }}>
        {meta.cert_standard || 'AS9100'} expires {months !== null ? `${months}mo` : meta.cert_expiry_date}
        {meta.cert_body ? ` — ${meta.cert_body}` : ''}
      </span>
    );
  }

  // Contract badge
  if (meta.contract_total) {
    badges.push(
      <span key="contract" className="signal-badge contract" style={{
        background: meta.dod_flag ? '#eff6ff' : '#f0fdf4',
        color: meta.dod_flag ? '#1e40af' : '#166534',
        padding: '2px 8px', borderRadius: '4px', fontSize: '12px',
        border: `1px solid ${meta.dod_flag ? '#93c5fd' : '#86efac'}`,
      }}>
        {meta.dod_flag ? 'DoD' : 'Govt'} contract {formatCurrency(meta.contract_total)}
      </span>
    );
  }

  // Multi-source badge
  if (meta.source_count > 1) {
    badges.push(
      <span key="multi" className="signal-badge multi" style={{
        background: '#faf5ff', color: '#6b21a8',
        padding: '2px 8px', borderRadius: '4px', fontSize: '12px',
        border: '1px solid #c084fc',
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
