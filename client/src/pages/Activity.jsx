import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Tabs from '@radix-ui/react-tabs';
import { motion, AnimatePresence } from 'framer-motion';
import useActivity from '../hooks/useActivity';
import { getCallDetail, getActivityTimeline, saveDisposition, setCallInternal } from '../lib/api';
import {
  formatDuration,
  dateBucket,
  DATE_BUCKET_LABELS,
  DATE_BUCKET_ORDER,
  formatRelativeTime,
  humanizeDisposition,
} from '../lib/format';
import { CALLER_OPTIONS } from '../lib/team';

/* ─────────────────── Design tokens ─────────────────── */

// Disposition → left-edge color bar
const DISP_BAR = {
  connected: 'bg-aunshin-success',
  voicemail: 'bg-aunshin-sodium',
  no_answer: 'bg-gray-600',
  callback_requested: 'bg-aunshin-sodium',
  qualified_hot: 'bg-aunshin-alert',
  qualified_warm: 'bg-aunshin-sodium',
  not_interested: 'bg-gray-500',
  wrong_number: 'bg-gray-500',
  gatekeeper: 'bg-gray-500',
};

// Disposition label pill styling
const DISP_PILL = {
  connected: 'bg-aunshin-success/20 text-aunshin-success',
  voicemail: 'bg-aunshin-sodium/20 text-aunshin-sodium',
  no_answer: 'bg-gray-500/20 text-gray-400',
  callback_requested: 'bg-aunshin-sodium/20 text-aunshin-sodium',
  qualified_hot: 'bg-aunshin-alert/20 text-aunshin-alert',
  qualified_warm: 'bg-aunshin-sodium/20 text-aunshin-sodium',
  not_interested: 'bg-aunshin-alert/20 text-aunshin-alert',
  wrong_number: 'bg-aunshin-alert/20 text-aunshin-alert',
  gatekeeper: 'bg-gray-500/20 text-gray-400',
};

const SENTIMENT_DOT = {
  positive: 'bg-aunshin-success',
  neutral: 'bg-gray-500',
  negative: 'bg-aunshin-alert',
  mixed: 'bg-aunshin-sodium',
};

const FILTER_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'hasNotes', label: 'Has notes' },
  { key: 'hot', label: 'Hot' },
  { key: 'warm', label: 'Warm' },
  { key: 'connected', label: 'Connected' },
  { key: 'voicemail', label: 'Voicemail' },
  { key: 'today', label: 'Today' },
  { key: 'thisWeek', label: 'This week' },
];

const DISPOSITION_OPTIONS = [
  { value: 'connected', label: 'Connected' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'callback_requested', label: 'Callback' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'wrong_number', label: 'Wrong #' },
  { value: 'gatekeeper', label: 'Gatekeeper' },
];

const QUALIFICATION_OPTIONS = [
  { value: 'hot', label: 'Hot', className: 'bg-aunshin-alert/20 text-aunshin-alert border-aunshin-alert/40' },
  { value: 'warm', label: 'Warm', className: 'bg-aunshin-sodium/20 text-aunshin-sodium border-aunshin-sodium/40' },
  { value: 'cold', label: 'Cold', className: 'bg-gray-500/20 text-gray-400 border-gray-500/40' },
];

/* ─────────────────── Subcomponents ─────────────────── */

function FilterBar({ search, setSearch, filter, setFilter, caller, setCaller, searchRef }) {
  return (
    <div className="sticky top-0 z-10 bg-aunshin-twilight/95 backdrop-blur-sm border-b border-aunshin-rule-d pb-3">
      <div className="px-4 pt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes, companies, products..."
            className="w-full bg-aunshin-twilight-2 border border-aunshin-rule-d rounded-lg px-4 py-2 pl-9 text-sm text-white placeholder:text-aunshin-quiet-d focus:outline-none focus:border-aunshin-sodium/50"
          />
          <svg className="absolute left-3 top-2.5 w-4 h-4 text-aunshin-quiet-d" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        {setCaller && (
          <select
            value={caller}
            onChange={(e) => setCaller(e.target.value)}
            className="bg-aunshin-twilight-2 border border-aunshin-rule-d rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">All callers</option>
            {CALLER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="px-4 pt-3 flex gap-2 overflow-x-auto scroll-container scrollbar-none">
        {FILTER_PILLS.map((p) => {
          const active = filter === p.key;
          return (
            <button
              key={p.key}
              onClick={() => setFilter(p.key)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                active
                  ? 'bg-aunshin-sodium text-black'
                  : 'bg-aunshin-twilight-2 border border-aunshin-rule-d text-aunshin-quiet-d hover:text-white'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SentimentDot({ sentiment }) {
  const overall = typeof sentiment === 'object' ? sentiment?.overall : sentiment;
  if (!overall || !SENTIMENT_DOT[overall]) return null;
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${SENTIMENT_DOT[overall]}`}
      title={`Sentiment: ${overall}`}
    />
  );
}

export function cockpitIdentifier(call) {
  return call.lead_phone || call.lead_email || null;
}

export function ActivityCard({ call, onOpen, selected }) {
  const navigate = useNavigate();
  const summary = call.ai_summary || call.ci_summary || call.notes || '';
  const truncated = summary.length > 180 ? summary.substring(0, 180) + '...' : summary;
  const products = call.products_discussed || call.ci_products || [];
  const productList = Array.isArray(products) ? products : [];
  const barColor = DISP_BAR[call.disposition] || 'bg-gray-700';
  const cockpitId = cockpitIdentifier(call);

  function handleKeyDown(e) {
    // Ignore bubbled keypresses from descendants (e.g. the cockpit icon button
    // would otherwise fire both its own click AND this card's onOpen on Space).
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(call);
    }
  }

  function handleCockpitClick(e) {
    e.stopPropagation();
    if (cockpitId) navigate(`/cockpit/${encodeURIComponent(cockpitId)}`);
  }

  const cardLabel = [
    call.lead_name || 'Unknown',
    call.lead_company,
    call.disposition && humanizeDisposition(call.disposition),
    formatRelativeTime(call.created_at),
  ].filter(Boolean).join(', ');

  return (
    <motion.div
      layout
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.99 }}
      role="button"
      tabIndex={0}
      aria-label={cardLabel}
      aria-pressed={selected}
      onClick={() => onOpen(call)}
      onKeyDown={handleKeyDown}
      className={`w-full text-left bg-aunshin-twilight-2 border rounded-xl overflow-hidden transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-aunshin-sodium focus-visible:ring-offset-2 focus-visible:ring-offset-aunshin-twilight ${
        selected ? 'border-aunshin-sodium/60' : 'border-aunshin-rule-d hover:border-aunshin-sodium/40'
      }`}
    >
      <div className="flex">
        <div className={`w-1 shrink-0 ${barColor}`} />
        <div className="flex-1 p-4 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium truncate text-white">{call.lead_name || 'Unknown'}</p>
                <SentimentDot sentiment={call.sentiment} />
              </div>
              <p className="text-sm text-aunshin-quiet-d truncate">{call.lead_company || ''}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-aunshin-quiet-d">{formatDuration(call.duration_seconds)}</span>
              {call.disposition && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${DISP_PILL[call.disposition] || 'bg-gray-500/20 text-gray-400'}`}>
                  {humanizeDisposition(call.disposition)}
                </span>
              )}
              {cockpitId && (
                <button
                  onClick={handleCockpitClick}
                  title="Open contact cockpit"
                  aria-label="Open contact cockpit"
                  className="w-7 h-7 flex items-center justify-center rounded-full bg-aunshin-sodium/10 text-aunshin-sodium hover:bg-aunshin-sodium/25 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {truncated && (
            <p className="text-sm text-aunshin-peach-light/80 mt-2 leading-relaxed line-clamp-2">{truncated}</p>
          )}

          <div className="flex items-center justify-between mt-3 gap-2">
            <div className="flex flex-wrap gap-1 min-w-0">
              {productList.slice(0, 3).map((p, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-aunshin-sodium/10 text-aunshin-sodium truncate">
                  {p}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-aunshin-quiet-d shrink-0">
              <span className="capitalize">{call.caller_identity}</span>
              <span>·</span>
              <span>{formatRelativeTime(call.created_at)}</span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function DateGroup({ label, children }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-2 px-1">
        {label}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function DispositionActions({ detail, emailReady, onSaved }) {
  const [disposition, setDisposition] = useState(detail.disposition || '');
  const [qualification, setQualification] = useState(detail.qualification || '');
  const [notes, setNotes] = useState(detail.notes || '');
  const [sendEmail, setSendEmail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // 'saved' | 'error'

  async function handleSave() {
    if (!disposition) {
      setStatus('error');
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const updated = await saveDisposition(detail.id, {
        disposition,
        qualification: qualification || null,
        notes: notes || null,
        products_discussed: detail.products_discussed || [],
        send_follow_up: sendEmail && emailReady,
      });
      setStatus('saved');
      onSaved(updated);
    } catch (err) {
      setStatus('error');
    }
    setSaving(false);
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-2">Disposition</h4>
        <div className="flex flex-wrap gap-1.5">
          {DISPOSITION_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setDisposition(o.value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                disposition === o.value
                  ? 'bg-aunshin-sodium/20 text-aunshin-sodium border-aunshin-sodium/50'
                  : 'bg-aunshin-twilight-2 text-aunshin-quiet-d border-aunshin-rule-d hover:border-aunshin-sodium/30'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-2">Qualification</h4>
        <div className="flex gap-1.5">
          {QUALIFICATION_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setQualification(qualification === o.value ? '' : o.value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                qualification === o.value
                  ? o.className
                  : 'bg-aunshin-twilight-2 text-aunshin-quiet-d border-aunshin-rule-d hover:border-aunshin-sodium/30'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-2">Notes</h4>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Add call notes..."
          className="w-full bg-aunshin-twilight-2 border border-aunshin-rule-d rounded-lg px-3 py-2 text-sm text-white placeholder:text-aunshin-quiet-d focus:outline-none focus:border-aunshin-sodium/50 resize-none"
        />
      </div>

      {/* Follow-up email toggle */}
      <div>
        <button
          onClick={() => emailReady && setSendEmail(!sendEmail)}
          disabled={!emailReady}
          title={!emailReady ? 'Re-login required to enable email' : ''}
          className={`flex items-center gap-2 text-sm ${!emailReady ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
          <span className={`w-10 h-5 rounded-full transition-colors ${sendEmail && emailReady ? 'bg-aunshin-success' : 'bg-aunshin-rule-d'} relative`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${sendEmail && emailReady ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </span>
          <span className="text-aunshin-peach-light">Send follow-up email</span>
        </button>
        {!emailReady && (
          <p className="text-[11px] text-aunshin-sodium mt-1">
            <a href="/api/auth/login" className="underline">Re-login</a> to enable email sending
          </p>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={saving || !disposition}
        className="w-full py-2.5 rounded-lg bg-aunshin-sodium text-black text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>

      {status === 'saved' && (
        <p className="text-xs text-aunshin-success text-center">Saved ✓</p>
      )}
      {status === 'error' && (
        <p className="text-xs text-aunshin-alert text-center">Failed to save — try again</p>
      )}
    </div>
  );
}

function TimelineTab({ callId }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Reset state on each callId change so a stale "No prior interactions"
    // message doesn't flash between loads.
    setLoading(true);
    setError(null);
    setItems(null);
    const controller = new AbortController();
    let cancelled = false;
    getActivityTimeline(callId, { signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setItems(data.interactions || []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError('Failed to load timeline');
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [callId]);

  if (loading) return <p className="text-center text-aunshin-quiet-d py-4 text-sm">Loading timeline...</p>;
  if (error) return <p className="text-center text-aunshin-alert py-4 text-sm">{error}</p>;
  if (!items || items.length === 0) {
    return <p className="text-center text-aunshin-quiet-d py-4 text-sm">No prior interactions with this contact.</p>;
  }

  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.id} className="bg-aunshin-twilight-2/50 border border-aunshin-rule-d rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-aunshin-quiet-d capitalize">{it.channel}</span>
            <span className="text-xs text-aunshin-quiet-d">{formatRelativeTime(it.createdAt)}</span>
          </div>
          {it.summary && <p className="text-sm text-aunshin-peach-light/80 leading-relaxed">{it.summary}</p>}
          {it.disposition && (
            <span className={`inline-block mt-2 text-xs px-2 py-0.5 rounded-full ${DISP_PILL[it.disposition] || 'bg-gray-500/20 text-gray-400'}`}>
              {humanizeDisposition(it.disposition)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function DetailModal({ detail, loading, emailReady, role, onClose, onUpdated }) {
  // Wrap the conditional inside AnimatePresence so exit animations play on close.
  return (
    <AnimatePresence>
      {(detail || loading) && (
        <motion.div
          key="detail-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center lg:justify-end"
        >
          <div className="absolute inset-0 bg-black/60" onClick={onClose} />
          <motion.div
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="relative bg-aunshin-twilight-2 border border-aunshin-rule-d rounded-t-2xl sm:rounded-2xl lg:rounded-none w-full sm:max-w-lg lg:max-w-xl max-h-[85vh] sm:max-h-[90vh] lg:max-h-screen lg:h-screen overflow-hidden flex flex-col"
          >
            {loading && !detail ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <p className="text-aunshin-quiet-d">Loading...</p>
              </div>
            ) : detail ? (
              <DetailContent key={detail.id} detail={detail} emailReady={emailReady} role={role} onClose={onClose} onUpdated={onUpdated} />
            ) : null}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DetailContent({ detail, emailReady, role, onClose, onUpdated }) {
  const navigate = useNavigate();
  const isAdmin = role === 'admin';
  const [isInternal, setIsInternal] = useState(detail.is_internal === true);
  const [internalSaving, setInternalSaving] = useState(false);

  const toggleInternal = useCallback(async () => {
    const next = !isInternal;
    setInternalSaving(true);
    try {
      const updated = await setCallInternal(detail.id, next);
      // PATCH returns { id, is_internal } — forward it so the list row badge
      // updates via mergeRow (passing undefined here throws in mergeRow).
      setIsInternal(updated?.is_internal ?? next);
      onUpdated?.(updated);
    } catch (err) {
      console.error('Failed to update is_internal:', err);
    } finally {
      setInternalSaving(false);
    }
  }, [detail.id, isInternal, onUpdated]);

  const summary = detail.ai_summary || detail.ci_summary || detail.notes || 'No summary available';
  const actionItems = detail.ai_action_items;
  const products = detail.products_discussed || detail.ci_products || [];
  const productList = Array.isArray(products) ? products : [];
  const sentiment = detail.sentiment;
  const competitive = detail.competitive_intel;
  const transcript = detail.transcript || detail.ci_transcript || '';
  const cockpitId = cockpitIdentifier(detail);

  return (
    <>
      {/* Sticky header */}
      <div className="sticky top-0 bg-aunshin-twilight-2 border-b border-aunshin-rule-d px-4 py-3 flex items-center justify-between z-10 shrink-0">
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">{detail.lead_name || 'Unknown'}</p>
          <p className="text-sm text-aunshin-quiet-d truncate">{detail.lead_company || ''}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-3">
          <span className="text-xs text-aunshin-quiet-d">{formatRelativeTime(detail.created_at)}</span>
          {cockpitId && (
            <button
              onClick={() => navigate(`/cockpit/${encodeURIComponent(cockpitId)}`)}
              className="text-xs px-3 py-1.5 rounded-full bg-aunshin-sodium/15 text-aunshin-sodium hover:bg-aunshin-sodium/30 transition-colors font-semibold whitespace-nowrap"
            >
              Cockpit →
            </button>
          )}
          <button onClick={onClose} className="text-aunshin-quiet-d hover:text-white text-lg w-8 h-8 flex items-center justify-center" aria-label="Close">
            ×
          </button>
        </div>
      </div>

      {/* Meta row */}
      <div className="px-4 py-2 border-b border-aunshin-rule-d shrink-0 flex items-center gap-3 text-xs text-aunshin-quiet-d">
        <span>{formatDuration(detail.duration_seconds)}</span>
        <span>·</span>
        <span className="capitalize">{detail.caller_identity}</span>
        {detail.disposition && (
          <>
            <span>·</span>
            <span className={`px-2 py-0.5 rounded-full ${DISP_PILL[detail.disposition] || 'bg-gray-500/20 text-gray-400'}`}>
              {humanizeDisposition(detail.disposition)}
            </span>
          </>
        )}
        {isInternal && (
          <>
            <span>·</span>
            <span className="px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400" title="Excluded from sales metrics, dedup, and CRM sync">
              Internal
            </span>
          </>
        )}
        {isAdmin && (
          <button
            onClick={toggleInternal}
            disabled={internalSaving}
            className="ml-auto text-xs px-2 py-0.5 rounded-full bg-aunshin-twilight-1 text-aunshin-quiet-d hover:text-white transition-colors disabled:opacity-50 whitespace-nowrap"
            title="Internal calls are excluded from sales metrics, dedup, and CRM sync"
          >
            {isInternal ? 'Mark as sales call' : 'Mark internal'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <Tabs.Root defaultValue="summary" className="flex-1 flex flex-col overflow-hidden">
        <Tabs.List className="flex border-b border-aunshin-rule-d shrink-0 bg-aunshin-twilight-2">
          {['summary', 'transcript', 'actions', 'timeline'].map((val) => (
            <Tabs.Trigger
              key={val}
              value={val}
              className="flex-1 py-3 text-xs font-semibold uppercase tracking-wider text-aunshin-quiet-d data-[state=active]:text-aunshin-sodium data-[state=active]:border-b-2 data-[state=active]:border-aunshin-sodium transition-colors"
            >
              {val}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <div className="flex-1 overflow-y-auto scroll-container">
          <Tabs.Content value="summary" className="p-4 space-y-4">
            <div>
              <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-1">Summary</h4>
              <p className="text-sm leading-relaxed">{summary}</p>
            </div>
            {actionItems && (
              <div>
                <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-1">Action Items</h4>
                {Array.isArray(actionItems.action_items) ? (
                  <ul className="text-sm space-y-1">
                    {actionItems.action_items.map((item, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-aunshin-sodium shrink-0">-</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : typeof actionItems === 'object' ? (
                  <div className="text-sm space-y-1">
                    {actionItems.next_step && <p><span className="text-aunshin-sodium">Next:</span> {actionItems.next_step}</p>}
                    {actionItems.disposition_suggestion && <p><span className="text-aunshin-quiet-d">Suggested:</span> {actionItems.disposition_suggestion}</p>}
                  </div>
                ) : (
                  <p className="text-sm">{String(actionItems)}</p>
                )}
              </div>
            )}
            {productList.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-1">Products Discussed</h4>
                <div className="flex flex-wrap gap-1">
                  {productList.map((p, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 rounded bg-aunshin-sodium/10 text-aunshin-sodium">{p}</span>
                  ))}
                </div>
              </div>
            )}
            {sentiment && (
              <div>
                <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-1">Sentiment</h4>
                <p className="text-sm capitalize">
                  {typeof sentiment === 'object'
                    ? sentiment.overall || JSON.stringify(sentiment)
                    : sentiment}
                </p>
                {typeof sentiment === 'object' && sentiment.objections?.length > 0 && (
                  <div className="mt-1 text-sm">
                    <span className="text-aunshin-quiet-d text-xs">Objections:</span>
                    <ul className="mt-0.5 space-y-0.5">
                      {sentiment.objections.map((o, i) => (
                        <li key={i} className="text-xs text-aunshin-peach-light/80">- {o}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {competitive && (
              <div>
                <h4 className="text-xs font-semibold tracking-wider uppercase text-aunshin-quiet-d mb-1">Competitive Intel</h4>
                <p className="text-sm">
                  {typeof competitive === 'object'
                    ? (competitive.mentions || competitive.equipment || []).join(', ') || JSON.stringify(competitive)
                    : competitive}
                </p>
              </div>
            )}
            {detail.recording_url && (
              <a
                href={detail.recording_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-aunshin-sodium hover:underline block"
              >
                Listen to recording →
              </a>
            )}
          </Tabs.Content>

          <Tabs.Content value="transcript" className="p-4">
            {transcript ? (
              <pre className="text-xs text-aunshin-peach-light/80 leading-relaxed whitespace-pre-wrap font-sans">
                {transcript.length > 10000 ? transcript.substring(0, 10000) + '\n\n[truncated]' : transcript}
              </pre>
            ) : (
              <p className="text-center text-aunshin-quiet-d py-4 text-sm">No transcript available</p>
            )}
          </Tabs.Content>

          <Tabs.Content value="actions" className="p-4">
            <DispositionActions
              detail={detail}
              emailReady={emailReady}
              onSaved={onUpdated}
            />
          </Tabs.Content>

          <Tabs.Content value="timeline" className="p-4">
            <TimelineTab callId={detail.id} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </>
  );
}

/* ─────────────────── Main page ─────────────────── */

export default function Activity({ identity, role, emailReady }) {
  const {
    activity, total, loading, error,
    search, setSearch, caller, setCaller,
    filter, setFilter,
    loadMore, hasMore, mergeRow,
  } = useActivity(identity, role);

  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailAbortRef = useRef(null);
  const searchRef = useRef(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const handleOpen = useCallback(async (call) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setDetailLoading(true);
    setDetail(call); // show list data immediately
    try {
      const full = await getCallDetail(call.id, { signal: controller.signal });
      setDetail(full);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Keep the list data as fallback
    }
    if (!controller.signal.aborted) setDetailLoading(false);
  }, []);

  const handleClose = useCallback(() => {
    detailAbortRef.current?.abort();
    setDetail(null);
    setDetailLoading(false);
  }, []);

  const handleUpdated = useCallback((updated) => {
    mergeRow(updated);
    setDetail((prev) => (prev ? { ...prev, ...updated } : prev));
  }, [mergeRow]);

  // Keyboard shortcuts: / focus search, j/k navigate, Enter open, Esc close.
  // j/k/Enter are suppressed while the detail modal is open so they don't
  // move the list underneath.
  useEffect(() => {
    function onKey(e) {
      const tag = document.activeElement?.tagName;
      const inForm = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === 'Escape' && detail) {
        e.preventDefault();
        handleClose();
        return;
      }
      if (inForm && e.key !== 'Escape') return;
      if (detail) return; // suppress navigation keys when modal is open
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'j') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, activity.length - 1));
      } else if (e.key === 'k') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && selectedIndex >= 0 && activity[selectedIndex]) {
        e.preventDefault();
        handleOpen(activity[selectedIndex]);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activity, selectedIndex, detail, handleOpen, handleClose]);

  // Group calls by date bucket. Build an id→index map in one pass so cards
  // can look up their global index without O(n) indexOf during render.
  const grouped = {};
  const idToIndex = new Map();
  activity.forEach((call, i) => {
    idToIndex.set(call.id, i);
    const bucket = dateBucket(call.created_at);
    if (!grouped[bucket]) grouped[bucket] = [];
    grouped[bucket].push(call);
  });

  return (
    <div className="flex flex-col h-full">
      <FilterBar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        caller={caller}
        setCaller={setCaller}
        searchRef={searchRef}
      />

      <div className="flex-1 overflow-y-auto scroll-container p-4">
        {!loading && total > 0 && (
          <p className="text-xs text-aunshin-quiet-d mb-3">
            {total} call{total !== 1 ? 's' : ''}
          </p>
        )}

        {loading && activity.length === 0 && (
          <p className="text-center text-aunshin-quiet-d py-8">Loading...</p>
        )}
        {error && <p className="text-center text-aunshin-alert py-8">{error}</p>}
        {!loading && !error && activity.length === 0 && (
          <p className="text-center text-aunshin-quiet-d py-8">
            {search || filter !== 'all' ? 'No matching activity' : 'No activity yet'}
          </p>
        )}

        {DATE_BUCKET_ORDER.map((bucket) => {
          const calls = grouped[bucket];
          if (!calls || calls.length === 0) return null;
          return (
            <DateGroup key={bucket} label={DATE_BUCKET_LABELS[bucket]}>
              {calls.map((call) => (
                <ActivityCard
                  key={call.id}
                  call={call}
                  onOpen={handleOpen}
                  selected={idToIndex.get(call.id) === selectedIndex}
                />
              ))}
            </DateGroup>
          );
        })}

        {hasMore && !loading && (
          <button
            onClick={loadMore}
            className="w-full mt-4 py-2 text-sm text-aunshin-quiet-d hover:text-white transition-colors"
          >
            Load more
          </button>
        )}
      </div>

      <DetailModal
        detail={detail}
        loading={detailLoading && !detail}
        emailReady={emailReady}
        role={role}
        onClose={handleClose}
        onUpdated={handleUpdated}
      />
    </div>
  );
}
