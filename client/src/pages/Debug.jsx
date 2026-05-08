import { useState } from 'react';
import useDebug from '../hooks/useDebug';

function formatAge(minutes) {
  if (minutes == null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function healthColor(ageMinutes) {
  if (ageMinutes == null) return '#DC2626';
  if (ageMinutes < 10) return '#22C55E';
  if (ageMinutes < 60) return '#F2B86A';
  return '#DC2626';
}

function HealthCard({ source, data }) {
  const color = healthColor(data?.ageMinutes);
  return (
    <div
      className="rounded-lg px-4 py-3 flex items-center gap-3"
      style={{ background: '#2A1213', border: '1px solid rgba(92,57,43,0.5)' }}
    >
      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-aunshin-peach-light truncate">{source}</div>
        <div className="text-xs" style={{ color: 'rgba(239,209,175,0.5)' }}>
          {data ? formatAge(data.ageMinutes) : 'never seen'}
        </div>
      </div>
    </div>
  );
}

function EventRow({ event, expanded, onToggle }) {
  const levelColor = event.level === 'error' ? '#DC2626' : event.level === 'warn' ? '#F2B86A' : 'rgba(239,209,175,0.5)';
  const ts = new Date(event.ts).toLocaleTimeString();
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-aunshin-twilight-2/50 transition-colors"
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-xs font-mono" style={{ color: 'rgba(239,209,175,0.5)' }}>{ts}</td>
        <td className="px-3 py-2">
          <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: levelColor }} />
          <span className="text-xs" style={{ color: levelColor }}>{event.level}</span>
        </td>
        <td className="px-3 py-2 text-xs text-aunshin-sodium font-mono">{event.category}</td>
        <td className="px-3 py-2 text-xs text-aunshin-peach-light font-mono">{event.source}</td>
        <td className="px-3 py-2 text-xs text-aunshin-peach-light truncate max-w-[300px]">{event.summary}</td>
      </tr>
      {expanded && event.detail && (
        <tr>
          <td colSpan={5} className="px-3 py-2">
            <pre
              className="text-xs font-mono p-3 rounded overflow-x-auto"
              style={{ background: '#18090A', color: 'rgba(239,209,175,0.7)', maxHeight: '200px' }}
            >
              {JSON.stringify(event.detail, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

const CATEGORIES = ['all', 'webhook', 'error', 'integration', 'state_change', 'sweep'];

export default function Debug() {
  const { events, health, connections, sweep, loading, error, refresh } = useDebug();
  const [category, setCategory] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-aunshin-quiet-d">Loading debug data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-aunshin-alert text-sm">Failed to load debug data: {error}</p>
        <button onClick={refresh} className="text-aunshin-sodium text-sm underline">Retry</button>
      </div>
    );
  }

  const noEvents = !events?.events?.length;
  const noIntegrations = !health?.integrations || Object.keys(health.integrations).length === 0;
  const debugOff = noEvents && noIntegrations;

  const filteredEvents = category === 'all'
    ? events?.events || []
    : (events?.events || []).filter(e => e.category === category);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      {/* Debug off banner */}
      {debugOff && (
        <div
          className="rounded-lg px-4 py-3 text-center text-sm"
          style={{ background: 'rgba(242,184,106,0.1)', border: '1px solid rgba(242,184,106,0.3)', color: '#F2B86A' }}
        >
          DEBUG mode is off — set <code className="font-mono bg-aunshin-twilight-2 px-1.5 py-0.5 rounded text-xs">DEBUG=1</code> in Render env vars to enable event logging
        </div>
      )}

      {/* Integration Health */}
      <section>
        <h2 className="text-sm font-semibold text-aunshin-peach-light mb-3 tracking-wide uppercase">Integration Health</h2>
        {health?.db && (
          <div className="mb-3 flex items-center gap-3 text-xs" style={{ color: 'rgba(239,209,175,0.5)' }}>
            <span className="w-2 h-2 rounded-full" style={{ background: health.db.status === 'ok' ? '#22C55E' : '#DC2626' }} />
            DB: {health.db.status} ({health.db.latencyMs}ms)
            <span className="ml-4">Uptime: {Math.round(health.uptime_seconds / 60)}m</span>
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {health?.integrations && Object.entries(health.integrations).map(([source, data]) => (
            <HealthCard key={source} source={source} data={data} />
          ))}
          {noIntegrations && !debugOff && (
            <p className="text-xs col-span-full" style={{ color: 'rgba(239,209,175,0.4)' }}>No integrations tracked yet</p>
          )}
        </div>
      </section>

      {/* Active Connections */}
      <section>
        <h2 className="text-sm font-semibold text-aunshin-peach-light mb-3 tracking-wide uppercase">Active WebSocket Connections</h2>
        {connections?.total > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {connections.websockets.map(ws => (
              <div
                key={ws.callId}
                className="rounded-lg px-4 py-3"
                style={{ background: '#2A1213', border: '1px solid rgba(92,57,43,0.5)' }}
              >
                <div className="text-xs font-mono text-aunshin-sodium truncate">{ws.callId}</div>
                <div className="text-xs" style={{ color: 'rgba(239,209,175,0.5)' }}>{ws.listenerCount} listener{ws.listenerCount !== 1 ? 's' : ''}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'rgba(239,209,175,0.4)' }}>No active connections</p>
        )}
      </section>

      {/* Event Log */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-aunshin-peach-light tracking-wide uppercase">Event Log</h2>
          <div className="flex items-center gap-2">
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="text-xs px-2 py-1 rounded border bg-aunshin-twilight-2 text-aunshin-peach-light"
              style={{ borderColor: 'rgba(92,57,43,0.5)' }}
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>
              ))}
            </select>
            <span className="text-xs" style={{ color: 'rgba(239,209,175,0.4)' }}>
              {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
              {events?.total > 0 && ` / ${events.total} total`}
            </span>
          </div>
        </div>
        {filteredEvents.length > 0 ? (
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(92,57,43,0.5)' }}>
            <table className="w-full">
              <thead>
                <tr style={{ background: '#2A1213' }}>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(239,209,175,0.4)' }}>Time</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(239,209,175,0.4)' }}>Level</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(239,209,175,0.4)' }}>Category</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(239,209,175,0.4)' }}>Source</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(239,209,175,0.4)' }}>Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'rgba(92,57,43,0.3)' }}>
                {filteredEvents.map(event => (
                  <EventRow
                    key={event.id}
                    event={event}
                    expanded={expandedId === event.id}
                    onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'rgba(239,209,175,0.4)' }}>
            {debugOff ? 'No events — DEBUG mode is off' : 'No events matching filter'}
          </p>
        )}
      </section>

      {/* Sweep History */}
      <section>
        <h2 className="text-sm font-semibold text-aunshin-peach-light mb-3 tracking-wide uppercase">Sweep History</h2>
        {sweep?.events?.length > 0 ? (
          <div className="space-y-2">
            {sweep.events.map(event => (
              <div
                key={event.id}
                className="rounded-lg px-4 py-2 flex items-center gap-3"
                style={{ background: '#2A1213', border: '1px solid rgba(92,57,43,0.5)' }}
              >
                <span className="text-xs font-mono shrink-0" style={{ color: 'rgba(239,209,175,0.5)' }}>
                  {new Date(event.ts).toLocaleString()}
                </span>
                <span className="text-xs text-aunshin-peach-light">{event.summary}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'rgba(239,209,175,0.4)' }}>No sweep history</p>
        )}
      </section>
    </div>
  );
}
