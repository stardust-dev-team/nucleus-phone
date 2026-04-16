import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSignalContacts, getSignalCallbacks } from '../lib/api';
import usePwaInstall from '../hooks/usePwaInstall';

const TIER_COLORS = { spear: 'bg-jv-red', targeted: 'bg-jv-amber', awareness: 'bg-gray-500' };
const TIER_BORDER = { spear: 'border-jv-red', targeted: 'border-jv-amber', awareness: 'border-gray-500' };
const TIER_TEXT = { spear: 'text-jv-red', targeted: 'text-jv-amber', awareness: 'text-gray-400' };
const PAGE_SIZE = 50;

// Timezone filter options (labels only — mapping lives server-side in timezones.js)
const TIMEZONE_OPTIONS = [
  { value: 'eastern',  label: 'Eastern' },
  { value: 'central',  label: 'Central' },
  { value: 'mountain', label: 'Mountain' },
  { value: 'pacific',  label: 'Pacific' },
];

// Cache DateTimeFormat instances by IANA timezone (~6 unique, reused every tick)
const formatterCache = new Map();
function localTimeStr(iana, now) {
  if (!iana) return null;
  let fmt = formatterCache.get(iana);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: iana, hour: 'numeric', minute: '2-digit', hour12: true,
    });
    formatterCache.set(iana, fmt);
  }
  return fmt.format(now);
}

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

function CompanyCard({ company, navigate, twilioStatus, now }) {
  const contract = formatCurrency(company.contract_total);
  const cert = certBadge(company.cert_expiry_date, company.cert_standard);
  const certStr = formatExpiry(company.cert_expiry_date);
  const localTime = localTimeStr(company.iana_timezone, now);
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
          {localTime && (
            <span className="text-[10px] text-jv-muted shrink-0" title={`Local time in ${company.geo_state}`}>
              {company.geo_state} {localTime}
            </span>
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
                    {contact.call_history?.lastSummary && (
                      <span
                        className="text-[10px] text-jv-muted italic truncate block mt-0.5"
                        title={contact.call_history.lastSummary}
                      >
                        {contact.call_history.lastSummary}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] ${badge.cls}`}>{badge.text}</span>
                  {(contact.phone || contact.email) && (
                    <button
                      onClick={() => navigate(`/cockpit/${encodeURIComponent(contact.phone || contact.email)}`)}
                      className={`w-7 h-7 flex items-center justify-center rounded-full transition-colors ${
                        contact.phone
                          ? 'bg-jv-green/20 text-jv-green hover:bg-jv-green/30'
                          : 'bg-jv-accent/20 text-jv-accent hover:bg-jv-accent/30'
                      }`}
                      title={contact.phone ? `Call ${contact.phone}` : `View briefing (${contact.email})`}
                    >
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                        {contact.phone ? (
                          <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
                        ) : (
                          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                        )}
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

const FILTER_HAS_PHONE = 'has_phone';
const FILTER_HAS_CONTACTS = 'has_contacts';
const FILTER_ALL = 'all';

export default function Contacts({ identity, callState, twilioStatus }) {
  const [companies, setCompanies] = useState([]);
  const [total, setTotal] = useState(0);
  const [availableStates, setAvailableStates] = useState([]);
  const [callbacks, setCallbacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tier, setTier] = useState('');
  const [state, setState] = useState('');
  const [timezone, setTimezone] = useState('');
  const [contactFilter, setContactFilter] = useState(FILTER_HAS_PHONE);
  const [now, setNow] = useState(() => new Date());
  const navigate = useNavigate();
  const pwa = usePwaInstall();

  // Tick the clock every 60s for live local-time display
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Server-side pagination: fetch PAGE_SIZE at a time, accumulate on "Show more"
  const fetchPage = useCallback(async (offset = 0) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      // When no tier selected, fetch spear+targeted only (exclude awareness server-side)
      const tierParam = tier || 'spear,targeted';
      const data = await getSignalContacts({
        signal_tier: tierParam,
        geo_state: state || undefined,
        timezone: timezone || undefined,
        has_phone: false,
        limit: PAGE_SIZE,
        offset,
      });
      if (offset === 0) {
        setCompanies(data.companies || []);
        if (data.available_states) setAvailableStates(data.available_states);
      } else {
        setCompanies(prev => [...prev, ...(data.companies || [])]);
      }
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Signal contacts fetch failed:', err);
      if (offset === 0) setCompanies([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [tier, state, timezone]);

  useEffect(() => { fetchPage(0); }, [fetchPage]);

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

  // Client-side contact filter (phone/contacts/all) — applied on top of server-paginated data
  const filtered = contactFilter === FILTER_HAS_PHONE
    ? companies.filter(c => c.contacts?.some(ct => ct.phone))
    : contactFilter === FILTER_HAS_CONTACTS
      ? companies.filter(c => c.contact_count > 0)
      : companies;
  const filterHidingResults = filtered.length === 0 && companies.length > 0 && contactFilter !== FILTER_ALL;
  // Awareness exclusion is now server-side (tier param = 'spear,targeted' when no tier selected)
  const hasMore = companies.length < total;

  return (
    <div className="flex flex-col h-full">
      {/* PWA install banner */}
      {pwa.showBanner && (
        <div className="mx-4 mt-3 rounded-lg border border-jv-amber/30 bg-jv-amber/10 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/icons/icon-192.png" alt="" className="w-10 h-10 rounded-lg shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-jv-bone">Add Nucleus Phone to your home screen</p>
              <p className="text-xs text-jv-muted truncate">
                {pwa.isIos
                  ? 'Tap the share button, then "Add to Home Screen"'
                  : 'Quick access like a native app'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pwa.canPrompt && (
              <button
                onClick={pwa.install}
                className="px-3 py-1.5 rounded-lg bg-jv-amber text-jv-deep text-xs font-bold uppercase tracking-wide"
              >
                Install
              </button>
            )}
            <button
              onClick={pwa.dismiss}
              className="text-jv-muted hover:text-jv-bone text-lg leading-none px-1"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>
      )}

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
          value={timezone}
          onChange={e => { setTimezone(e.target.value); setState(''); }}
          className="px-2 py-1 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted"
        >
          <option value="">All timezones</option>
          {TIMEZONE_OPTIONS.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
        </select>
        <select
          value={state}
          onChange={e => { setState(e.target.value); setTimezone(''); }}
          className="px-2 py-1 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted"
        >
          <option value="">All states</option>
          {availableStates.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={contactFilter}
          onChange={e => setContactFilter(e.target.value)}
          className="px-2 py-1 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted"
        >
          <option value="has_phone">With phone numbers</option>
          <option value="has_contacts">With any contacts</option>
          <option value="all">All companies</option>
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
        {!loading && (filterHidingResults ? (
          <div className="text-center py-8">
            <p className="text-jv-muted">{companies.length} companies found, but none match the current filter.</p>
            <button
              onClick={() => setContactFilter(FILTER_ALL)}
              className="mt-2 px-3 py-1 rounded-lg bg-jv-accent/20 text-jv-accent text-sm hover:bg-jv-accent/30 transition-colors"
            >
              Show all {companies.length} companies
            </button>
          </div>
        ) : companies.length === 0 && (
          <p className="text-center text-jv-muted py-8">
            No companies match filters.{' '}
            {tier === '' ? 'Run signal loaders to populate the pipeline.' : 'Try a different tier.'}
          </p>
        ))}

        {filtered.map(company => (
          <CompanyCard
            key={company.domain}
            company={company}
            navigate={navigate}
            twilioStatus={twilioStatus}
            now={now}
          />
        ))}

        {hasMore && (
          <button
            onClick={() => fetchPage(companies.length)}
            disabled={loadingMore}
            className="w-full py-2 rounded-lg bg-jv-card border border-jv-border text-xs text-jv-muted hover:text-white transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : `Show more (${total - companies.length} remaining)`}
          </button>
        )}
      </div>
    </div>
  );
}
