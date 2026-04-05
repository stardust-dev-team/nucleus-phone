import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSignalContacts, getSignalCallbacks } from '../lib/api';

const TIER_COLORS = { spear: 'bg-jv-red', targeted: 'bg-jv-amber', awareness: 'bg-gray-500' };
const TIER_BORDER = { spear: 'border-jv-red', targeted: 'border-jv-amber', awareness: 'border-gray-500' };
const TIER_TEXT = { spear: 'text-jv-red', targeted: 'text-jv-amber', awareness: 'text-gray-400' };
const STATES = ['OH', 'TX', 'CA', 'MI', 'PA', 'CT', 'WI', 'MN', 'NY', 'FL', 'AZ'];

function TierBadge({ tier }) {
  return (
    <span className={`${TIER_COLORS[tier] || 'bg-gray-500'} text-white px-1.5 py-0.5 rounded text-[10px] font-bold uppercase`}>
      {tier}
    </span>
  );
}

function callBadge(callHistory) {
  if (!callHistory) return { text: 'Never called', cls: 'text-gray-500' };
  const days = Math.floor((Date.now() - new Date(callHistory.lastCall).getTime()) / 86400000);
  if (days === 0) return { text: 'Called today', cls: 'text-jv-green' };
  if (days === 1) return { text: 'Yesterday', cls: 'text-jv-green' };
  return { text: `${days}d ago`, cls: 'text-jv-muted' };
}

function dispositionDot(callHistory) {
  if (!callHistory) return 'bg-gray-500';
  switch (callHistory.lastDisposition) {
    case 'qualified_hot': return 'bg-jv-red';
    case 'qualified_warm': return 'bg-jv-amber';
    case 'callback_requested': return 'bg-jv-amber';
    case 'connected': return 'bg-jv-green';
    case 'not_interested': return 'bg-jv-red';
    default: return 'bg-jv-green';
  }
}

function formatCurrency(amount) {
  if (!amount) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(amount);
}

function formatExpiry(date) {
  if (!date) return null;
  const d = new Date(date);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ── Company Card ────────────────────────────────────────────────────

function certBadge(expiryDate, standard) {
  if (!expiryDate) return null;
  const expiry = new Date(expiryDate);
  if (isNaN(expiry.getTime())) return null;
  const months = Math.round((expiry - Date.now()) / (30 * 86400000));
  if (months < 0) return { text: `${standard || 'Cert'} EXPIRED`, cls: 'bg-jv-red/20 text-jv-red' };
  if (months <= 9) return { text: `${standard || 'Cert'} ${months}mo`, cls: 'bg-jv-amber/20 text-jv-amber' };
  return null; // Not urgent enough to badge
}

function CompanyCard({ company, navigate, twilioStatus }) {
  const contract = formatCurrency(company.contract_total);
  const cert = certBadge(company.cert_expiry_date, company.cert_standard);
  const certStr = formatExpiry(company.cert_expiry_date);
  const details = [
    !cert && certStr && `${company.cert_standard || 'Cert'} expires ${certStr}`,
    contract && `${company.dod_flag ? 'DoD ' : ''}${contract}`,
    company.source_count > 1 && `${company.source_count} sources`,
  ].filter(Boolean);

  return (
    <div className={`rounded-xl bg-jv-card border-l-4 ${TIER_BORDER[company.signal_tier] || 'border-gray-500'} border border-jv-border overflow-hidden`}>
      {/* Company header */}
      <div className="p-3 pb-1">
        <div className="flex items-center gap-2">
          <TierBadge tier={company.signal_tier} />
          <span className="font-medium text-sm truncate">{company.company_name || company.domain}</span>
          {cert && (
            <span className={`${cert.cls} px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0`}>
              {cert.text}
            </span>
          )}
          {company.dod_flag && (
            <span className="text-[10px] font-bold text-blue-400 shrink-0" title="DoD contractor">🛡</span>
          )}
          {company.interaction_count > 0 && (
            <span className="text-[10px] text-jv-muted shrink-0">{company.interaction_count} {company.interaction_count === 1 ? 'touch' : 'touches'}</span>
          )}
          <span className="text-jv-amber text-xs ml-auto shrink-0">⚡ {company.signal_score}</span>
        </div>
        {details.length > 0 && (
          <p className="text-xs text-jv-muted mt-1 ml-8">
            {details.join(' · ')}
          </p>
        )}
      </div>

      {/* Contacts */}
      <div className="px-3 pb-3">
        {company.contacts && company.contacts.length > 0 ? (
          company.contacts.map((contact, i) => {
            const badge = callBadge(contact.call_history);
            return (
              <div
                key={`${contact.linkedin_url || contact.full_name}-${i}`}
                className="flex items-center justify-between py-1.5 border-t border-jv-border/50 first:border-0"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {contact.call_history && (
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dispositionDot(contact.call_history)}`} />
                  )}
                  <div className="min-w-0">
                    <span className="text-xs font-medium truncate block">{contact.full_name || 'Unknown'}</span>
                    <span className="text-[10px] text-jv-muted truncate block">
                      {contact.title || 'No title'}
                      {contact.phone && ` · ${contact.phone}`}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] ${badge.cls}`}>{badge.text}</span>
                  {contact.phone && (
                    <button
                      onClick={() => navigate(`/cockpit/${encodeURIComponent(contact.phone)}`)}
                      className="w-7 h-7 flex items-center justify-center rounded-full bg-jv-green/20 text-jv-green hover:bg-jv-green/30 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-xs text-jv-muted py-2 border-t border-jv-border/50">
            {company.no_phone_count > 0
              ? `${company.no_phone_count} contacts without phone`
              : 'No contacts found'}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main Contacts Page (Signal Queue only) ──────────────────────────

export default function Contacts({ identity, callState, twilioStatus }) {
  const [companies, setCompanies] = useState([]);
  const [callbacks, setCallbacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState('');
  const [state, setState] = useState('');
  const [contactFilter, setContactFilter] = useState('all');
  const [awarenessOpen, setAwarenessOpen] = useState(false);
  const navigate = useNavigate();

  const fetchSignal = useCallback(async () => {
    setLoading(true);
    try {
      // Show all contacts — phone numbers populate as Apollo enrichment runs
      const data = await getSignalContacts({ signal_tier: tier || undefined, geo_state: state || undefined, has_phone: false, limit: 200 });
      setCompanies(data.companies || []);
    } catch (err) { console.error('Signal contacts fetch failed:', err); setCompanies([]); }
    finally { setLoading(false); }
  }, [tier, state]);

  useEffect(() => { fetchSignal(); }, [fetchSignal]);

  // Poll callbacks every 60s
  useEffect(() => {
    const fetchCb = async () => {
      try {
        const data = await getSignalCallbacks();
        setCallbacks(data.callbacks || []);
      } catch { /* graceful degradation */ }
    };
    fetchCb();
    const interval = setInterval(fetchCb, 60000);
    return () => clearInterval(interval);
  }, []);

  const filtered = contactFilter === 'has_contacts'
    ? companies.filter(c => c.contact_count > 0)
    : companies;
  const spearTargeted = filtered.filter(c => c.signal_tier !== 'awareness');
  const awareness = filtered.filter(c => c.signal_tier === 'awareness');

  return (
    <div className="flex flex-col h-full">
      {/* Tier + state filters */}
      <div className="flex gap-2 px-4 pt-4 pb-2 flex-wrap">
        {['spear', 'targeted', 'awareness'].map(t => (
          <button
            key={t}
            onClick={() => setTier(prev => prev === t ? '' : t)}
            className={`px-3 py-1 rounded-full text-xs uppercase font-bold transition-colors ${
              tier === t
                ? `${TIER_COLORS[t]} text-white`
                : `bg-jv-card border ${TIER_BORDER[t]} ${TIER_TEXT[t]}`
            }`}
          >
            {t}
          </button>
        ))}
        <select
          value={state}
          onChange={e => setState(e.target.value)}
          className="px-2 py-1 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted"
        >
          <option value="">All states</option>
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={contactFilter}
          onChange={e => setContactFilter(e.target.value)}
          className="px-2 py-1 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted"
        >
          <option value="all">All companies</option>
          <option value="has_contacts">With contacts found</option>
        </select>
      </div>

      {/* Callbacks banner */}
      {callbacks.length > 0 && (
        <div className="mx-4 mb-3 rounded-lg bg-jv-red/10 border border-jv-red/30 p-3">
          <p className="text-xs font-bold text-jv-red mb-1">CALLBACKS ({callbacks.length})</p>
          {callbacks.slice(0, 3).map(cb => (
            <div key={cb.id} className="flex items-center justify-between py-1">
              <div className="text-xs">
                <span className="text-white font-medium">{cb.company_name}</span>
                <span className="text-jv-muted ml-2">
                  {cb.trigger_reason === 'lead_gen' ? 'Lead gen form' : 'Email replied'}
                </span>
              </div>
              <button
                onClick={() => navigate(`/cockpit/${encodeURIComponent(cb.domain)}`)}
                className="text-xs px-2 py-0.5 rounded bg-jv-red/20 text-jv-red font-medium"
              >
                Call Now
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Company list */}
      <div className="flex-1 overflow-y-auto scroll-container px-4 space-y-3 pb-4">
        {loading && <p className="text-center text-jv-muted py-8">Loading signal queue...</p>}
        {!loading && companies.length === 0 && (
          <p className="text-center text-jv-muted py-8">
            No companies match filters.{' '}
            {tier === '' ? 'Run signal loaders to populate the pipeline.' : 'Try a different tier.'}
          </p>
        )}

        {spearTargeted.map(company => (
          <CompanyCard
            key={company.domain}
            company={company}
            navigate={navigate}
            twilioStatus={twilioStatus}
          />
        ))}

        {/* Awareness section — collapsed by default */}
        {awareness.length > 0 && !tier && (
          <div className="mt-4">
            <button
              onClick={() => setAwarenessOpen(!awarenessOpen)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted"
            >
              <span>AWARENESS ({awareness.length} companies)</span>
              <span>{awarenessOpen ? '▾' : '▸'}</span>
            </button>
            {awarenessOpen && (
              <div className="space-y-3 mt-3">
                {awareness.map(company => (
                  <CompanyCard
                    key={company.domain}
                    company={company}
                    navigate={navigate}
                    twilioStatus={twilioStatus}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
