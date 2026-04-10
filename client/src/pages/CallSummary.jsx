import { useState, useRef } from 'react';
import useCallSummaries from '../hooks/useCallSummaries';
import { getCallSummaryDetail } from '../lib/api';
import { formatDuration } from '../lib/format';

const DISP_COLORS = {
  connected: 'bg-jv-green/20 text-jv-green',
  voicemail: 'bg-jv-blue/20 text-jv-blue',
  no_answer: 'bg-gray-500/20 text-gray-400',
  callback_requested: 'bg-jv-amber/20 text-jv-amber',
  qualified_hot: 'bg-jv-red/20 text-jv-red',
  qualified_warm: 'bg-jv-amber/20 text-jv-amber',
  not_interested: 'bg-jv-red/20 text-jv-red',
  wrong_number: 'bg-jv-red/20 text-jv-red',
  gatekeeper: 'bg-gray-500/20 text-gray-400',
};

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 1) return 'Yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function SummaryCard({ summary, onSelect }) {
  const best = summary.ai_summary || summary.ci_summary || summary.notes || '';
  const truncated = best.length > 180 ? best.substring(0, 180) + '...' : best;
  const products = summary.products_discussed || summary.ci_products || [];
  const productList = Array.isArray(products) ? products : [];

  return (
    <button
      className="w-full text-left bg-jv-card border border-jv-border rounded-xl p-4 hover:border-jv-amber/40 transition-colors"
      onClick={() => onSelect(summary.id)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{summary.lead_name || 'Unknown'}</p>
          <p className="text-sm text-jv-muted truncate">{summary.lead_company || ''}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-jv-muted">{formatDuration(summary.duration_seconds)}</span>
          {summary.disposition && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${DISP_COLORS[summary.disposition] || 'bg-gray-500/20 text-gray-400'}`}>
              {summary.disposition.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>

      {truncated && (
        <p className="text-sm text-jv-bone/80 mt-2 leading-relaxed">{truncated}</p>
      )}

      <div className="flex items-center justify-between mt-3">
        <div className="flex flex-wrap gap-1">
          {productList.slice(0, 3).map((p, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-jv-amber/10 text-jv-amber">
              {p}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-jv-muted">
          <span className="capitalize">{summary.caller_identity}</span>
          <span>{formatDate(summary.created_at)}</span>
        </div>
      </div>
    </button>
  );
}

function SummaryDetail({ detail, loading, onClose }) {
  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <div className="relative bg-jv-card border border-jv-border rounded-2xl p-8">
          <p className="text-jv-muted">Loading...</p>
        </div>
      </div>
    );
  }
  if (!detail) return null;

  const summary = detail.ai_summary || detail.ci_summary || detail.notes || 'No summary available';
  const actionItems = detail.ai_action_items;
  const products = detail.products_discussed || detail.ci_products || [];
  const productList = Array.isArray(products) ? products : [];
  const sentiment = detail.sentiment;
  const competitive = detail.competitive_intel;
  const transcript = detail.transcript || detail.ci_transcript || '';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-jv-card border border-jv-border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] overflow-y-auto scroll-container">
        <div className="sticky top-0 bg-jv-card border-b border-jv-border px-4 py-3 flex items-center justify-between z-10">
          <div>
            <p className="font-semibold">{detail.lead_name || 'Unknown'}</p>
            <p className="text-sm text-jv-muted">{detail.lead_company || ''}</p>
          </div>
          <button onClick={onClose} className="text-jv-muted hover:text-white text-lg px-2">x</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Meta row */}
          <div className="flex items-center gap-3 text-sm text-jv-muted">
            <span>{formatDate(detail.created_at)}</span>
            <span>{formatDuration(detail.duration_seconds)}</span>
            <span className="capitalize">{detail.caller_identity}</span>
            {detail.disposition && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${DISP_COLORS[detail.disposition] || 'bg-gray-500/20 text-gray-400'}`}>
                {detail.disposition.replace(/_/g, ' ')}
              </span>
            )}
          </div>

          {/* Summary */}
          <div>
            <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Summary</h3>
            <p className="text-sm leading-relaxed">{summary}</p>
          </div>

          {/* Action Items */}
          {actionItems && (
            <div>
              <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Action Items</h3>
              {Array.isArray(actionItems.action_items) ? (
                <ul className="text-sm space-y-1">
                  {actionItems.action_items.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-jv-amber shrink-0">-</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : typeof actionItems === 'object' ? (
                <div className="text-sm space-y-1">
                  {actionItems.next_step && <p><span className="text-jv-amber">Next:</span> {actionItems.next_step}</p>}
                  {actionItems.disposition_suggestion && <p><span className="text-jv-muted">Suggested:</span> {actionItems.disposition_suggestion}</p>}
                </div>
              ) : (
                <p className="text-sm">{String(actionItems)}</p>
              )}
            </div>
          )}

          {/* Products */}
          {productList.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Products Discussed</h3>
              <div className="flex flex-wrap gap-1">
                {productList.map((p, i) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded bg-jv-amber/10 text-jv-amber">{p}</span>
                ))}
              </div>
            </div>
          )}

          {/* Sentiment */}
          {sentiment && (
            <div>
              <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Sentiment</h3>
              <p className="text-sm capitalize">{typeof sentiment === 'object' ? sentiment.overall || JSON.stringify(sentiment) : sentiment}</p>
            </div>
          )}

          {/* Competitive Intel */}
          {competitive && (
            <div>
              <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Competitive Intel</h3>
              <p className="text-sm">
                {typeof competitive === 'object'
                  ? (competitive.mentions || competitive.equipment || []).join(', ') || JSON.stringify(competitive)
                  : competitive}
              </p>
            </div>
          )}

          {/* Notes */}
          {detail.notes && detail.notes !== summary && (
            <div>
              <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Rep Notes</h3>
              <p className="text-sm leading-relaxed">{detail.notes}</p>
            </div>
          )}

          {/* Transcript excerpt */}
          {transcript && (
            <div>
              <h3 className="text-xs font-semibold tracking-wider uppercase text-jv-muted mb-1">Transcript</h3>
              <div className="text-xs text-jv-muted leading-relaxed max-h-40 overflow-y-auto bg-black/20 rounded-lg p-3">
                {transcript.length > 2000 ? transcript.substring(0, 2000) + '\n\n[truncated]' : transcript}
              </div>
            </div>
          )}

          {/* Recording link */}
          {detail.recording_url && (
            <a
              href={detail.recording_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-jv-blue hover:underline block"
            >
              Listen to recording
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CallSummary({ identity, role }) {
  const {
    summaries, total, loading, error,
    search, setSearch, caller, setCaller,
    loadMore, hasMore, refresh,
  } = useCallSummaries(identity, role);

  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailAbortRef = useRef(null);

  async function handleSelect(id) {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;

    setDetailLoading(true);
    try {
      const data = await getCallSummaryDetail(id, { signal: controller.signal });
      setDetail(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setDetail(summaries.find(s => s.id === id) || null);
    }
    if (!controller.signal.aborted) setDetailLoading(false);
  }

  return (
    <div className="h-full overflow-y-auto scroll-container p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Call Notes</h2>
        <div className="flex items-center gap-2">
          {/* Caller list mirrors History.jsx — source: server/config/team.json */}
          {setCaller && (
            <select
              value={caller}
              onChange={(e) => setCaller(e.target.value)}
              className="bg-jv-card border border-jv-border rounded-lg px-3 py-1.5 text-sm text-white"
            >
              <option value="">All callers</option>
              <option value="tom">Tom</option>
              <option value="paul">Paul</option>
              <option value="kate">Kate</option>
              <option value="britt">Britt</option>
              <option value="ryann">Ryann</option>
              <option value="alex">Alex</option>
              <option value="lily">Lily</option>
            </select>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search summaries, companies, products..."
          className="w-full bg-jv-card border border-jv-border rounded-lg px-4 py-2 text-sm text-white placeholder:text-jv-muted focus:outline-none focus:border-jv-amber/50"
        />
      </div>

      {/* Results count */}
      {!loading && total > 0 && (
        <p className="text-xs text-jv-muted mb-3">{total} call{total !== 1 ? 's' : ''} with notes</p>
      )}

      {loading && <p className="text-center text-jv-muted py-8">Loading...</p>}
      {error && <p className="text-center text-jv-red py-8">{error}</p>}
      {!loading && !error && summaries.length === 0 && (
        <p className="text-center text-jv-muted py-8">
          {search ? 'No matching summaries' : 'No call summaries yet'}
        </p>
      )}

      {/* Cards */}
      <div className="space-y-2">
        {summaries.map((s) => (
          <SummaryCard key={s.id} summary={s} onSelect={handleSelect} />
        ))}
      </div>

      {/* Load more */}
      {hasMore && !loading && (
        <button
          onClick={loadMore}
          className="w-full mt-4 py-2 text-sm text-jv-muted hover:text-white transition-colors"
        >
          Load more
        </button>
      )}

      {/* Detail modal */}
      {(detail || detailLoading) && (
        <SummaryDetail
          detail={detail}
          loading={detailLoading}
          onClose={() => { setDetail(null); setDetailLoading(false); }}
        />
      )}
    </div>
  );
}
