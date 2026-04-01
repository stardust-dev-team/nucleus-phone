import { useState, useEffect } from 'react';

const TIER_COLORS = {
  spear: '#dc2626',
  targeted: '#f59e0b',
  awareness: '#6b7280',
};

const STAGE_ORDER = [
  'identified', 'priming', 'outreach', 'engaged',
  'active', 'opportunity', 'won',
];

function TierBadge({ tier }) {
  const bg = TIER_COLORS[tier] || '#6b7280';
  return (
    <span style={{
      background: bg, color: '#fff',
      padding: '1px 6px', borderRadius: '3px',
      fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase',
    }}>
      {tier}
    </span>
  );
}

function formatCurrency(amount) {
  if (!amount) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(amount);
}

export default function Pipeline() {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ tier: '', state: '' });

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter.tier) params.set('signal_tier', filter.tier);
    if (filter.state) params.set('geo_state', filter.state);
    params.set('limit', '100');

    fetch(`/api/signals/pipeline?${params}`)
      .then(r => r.ok ? r.json() : { companies: [] })
      .then(d => setCompanies(d.companies || []))
      .catch(() => setCompanies([]))
      .finally(() => setLoading(false));
  }, [filter.tier, filter.state]);

  const tierCounts = companies.reduce((acc, c) => {
    acc[c.signal_tier] = (acc[c.signal_tier] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
        Signal Pipeline
      </h1>

      {/* Tier summary */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
        {['spear', 'targeted', 'awareness'].map(tier => (
          <button
            key={tier}
            onClick={() => setFilter(f => ({ ...f, tier: f.tier === tier ? '' : tier }))}
            style={{
              padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
              border: filter.tier === tier ? '2px solid #000' : '1px solid #d1d5db',
              background: filter.tier === tier ? TIER_COLORS[tier] + '20' : '#fff',
            }}
          >
            <TierBadge tier={tier} />
            <span style={{ marginLeft: '8px', fontWeight: 'bold' }}>
              {tierCounts[tier] || 0}
            </span>
          </button>
        ))}
      </div>

      {/* State filter */}
      <div style={{ marginBottom: '16px' }}>
        <select
          value={filter.state}
          onChange={e => setFilter(f => ({ ...f, state: e.target.value }))}
          style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #d1d5db' }}
        >
          <option value="">All states</option>
          {['OH', 'TX', 'CA', 'MI', 'PA', 'CT', 'WI', 'MN', 'NY', 'FL', 'AZ'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div>Loading pipeline...</div>
      ) : companies.length === 0 ? (
        <div style={{ color: '#6b7280' }}>No companies match filters. Run signal loaders first.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '8px' }}>Company</th>
              <th style={{ padding: '8px' }}>State</th>
              <th style={{ padding: '8px' }}>Tier</th>
              <th style={{ padding: '8px' }}>Score</th>
              <th style={{ padding: '8px' }}>Sources</th>
              <th style={{ padding: '8px' }}>Cert Expiry</th>
              <th style={{ padding: '8px' }}>Contract</th>
              <th style={{ padding: '8px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c, i) => (
              <tr key={c.domain} style={{
                borderBottom: '1px solid #f3f4f6',
                background: i % 2 === 0 ? '#fff' : '#f9fafb',
              }}>
                <td style={{ padding: '8px', fontWeight: 500 }}>{c.company_name || c.domain}</td>
                <td style={{ padding: '8px' }}>{c.geo_state}</td>
                <td style={{ padding: '8px' }}><TierBadge tier={c.signal_tier} /></td>
                <td style={{ padding: '8px' }}>{c.signal_score}</td>
                <td style={{ padding: '8px' }}>{c.source_count}x</td>
                <td style={{ padding: '8px' }}>{c.cert_expiry_date || '—'}</td>
                <td style={{ padding: '8px' }}>{formatCurrency(c.contract_total)}</td>
                <td style={{ padding: '8px' }}>
                  <span style={{
                    fontSize: '11px', padding: '2px 6px', borderRadius: '3px',
                    background: c.enrichment_status === 'sent' ? '#d1fae5' :
                      c.enrichment_status === 'enriched' ? '#dbeafe' : '#f3f4f6',
                  }}>
                    {c.enrichment_status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
