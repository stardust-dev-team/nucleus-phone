/**
 * LiveAnalysis — Real-time equipment detection, air demand sizing, and CAS
 * product recommendation widget. Teal/cyan accent to stand out as the primary
 * live intelligence panel.
 *
 * Progressive phases:
 *   1. Listening  — pulsing dot, awaiting equipment mentions
 *   2. Equipment  — bold badges per detected machine
 *   3. Sizing     — aggregated CFM / PSI demand bar
 *   4. Recommend  — CAS compressor card with dryer/filter upsells
 */

function hasEquipment({ equipment, sizing, recommendation }) {
  return recommendation || sizing || equipment.length > 0;
}

function formatCfm(n) {
  if (n == null) return '—';
  return `${Math.round(n)} CFM`;
}

function formatPrice(price) {
  if (price == null) return 'Pricing on request';
  return `$${Number(price).toLocaleString()}`;
}

export default function LiveAnalysis({ data, active }) {
  const safe = data || {};
  const { equipment = [], sizing, recommendation, connected = false } = safe;

  const detected = hasEquipment(safe);
  const idle = !active && !connected && !detected;

  return (
    <div
      className="rounded-xl overflow-hidden transition-all duration-500 flex flex-col"
      style={{
        border: `2px solid ${detected ? 'var(--cockpit-live-500)' : 'var(--cockpit-live-border)'}`,
        background: 'var(--cockpit-card)',
        minHeight: idle ? '120px' : '280px',
        animation: active && connected && !detected
          ? 'live-border-shimmer 3s ease-in-out infinite'
          : 'none',
        boxShadow: detected
          ? '0 0 24px 4px var(--cockpit-live-glow), inset 0 1px 0 var(--cockpit-live-border)'
          : active
            ? '0 0 12px 0 var(--cockpit-live-glow)'
            : 'none',
      }}
    >
      {/* Header bar */}
      <div
        className="flex items-center gap-2.5 px-4 py-2"
        style={{
          background: detected
            ? 'var(--cockpit-live-500)'
            : 'var(--cockpit-live-bg)',
          borderBottom: '1px solid var(--cockpit-live-border)',
        }}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            background: detected ? '#FFFFFF' : connected ? 'var(--cockpit-live-500)' : 'var(--cockpit-text-muted)',
            animation: connected ? 'live-pulse 2s ease-in-out infinite' : 'none',
          }}
        />
        {active && (
          <span
            className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded"
            style={{
              background: detected ? 'rgba(255,255,255,0.25)' : 'var(--cockpit-live-badge-bg)',
              color: detected ? '#FFFFFF' : 'var(--cockpit-live-500)',
            }}
          >
            LIVE
          </span>
        )}
        <span className="text-[11px] font-semibold tracking-wide uppercase" style={{ color: detected ? '#FFFFFF' : 'var(--cockpit-live-900)' }}>
          Live Analysis
        </span>
        {sizing && (
          <span
            className="ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full"
            style={{
              background: detected ? 'rgba(255,255,255,0.2)' : 'var(--cockpit-live-badge-bg)',
              color: detected ? '#FFFFFF' : 'var(--cockpit-live-500)',
            }}
          >
            {formatCfm(sizing.totalCfmAtDuty)} demand
          </span>
        )}
      </div>

      {/* Viewscreen body — vertically centered when idle */}
      {!detected && (
        <div className="flex-1 flex items-center justify-center px-4 py-6">
          <div className="text-center">
            <div
              className="mx-auto mb-3 w-10 h-10 rounded-full flex items-center justify-center"
              style={{
                background: 'var(--cockpit-live-bg)',
                border: '2px solid var(--cockpit-live-border)',
                animation: connected ? 'live-pulse 3s ease-in-out infinite' : 'none',
              }}
            >
              <span
                className="w-3 h-3 rounded-full"
                style={{
                  background: connected ? 'var(--cockpit-live-500)' : 'var(--cockpit-text-muted)',
                }}
              />
            </div>
            <p className="text-[14px] font-medium" style={{ color: 'var(--cockpit-live-900)' }}>
              {!active
                ? 'Start a practice call to activate'
                : connected
                  ? 'Listening for equipment mentions...'
                  : 'Connecting...'}
            </p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--cockpit-text-muted)' }}>
              {active
                ? 'Equipment detections appear here in real time'
                : 'Select a difficulty and begin your call'}
            </p>
          </div>
        </div>
      )}

      {/* ── Detected content ── */}
      {detected && (
        <div className="text-center py-2" style={{ background: 'var(--cockpit-live-bg)' }}>
          <span className="text-[13px] font-bold" style={{ color: 'var(--cockpit-live-900)' }}>
            {equipment.length} {equipment.length === 1 ? 'machine' : 'machines'} detected
          </span>
        </div>
      )}

      {/* Equipment badges */}
      {equipment.length > 0 && (
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {equipment.map((eq, i) => (
            <span
              key={`${eq.manufacturer}-${eq.model}-${i}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
              style={{
                background: 'var(--cockpit-live-bg)',
                color: 'var(--cockpit-live-900)',
                border: eq.catalogMatch
                  ? '1px solid var(--cockpit-live-border)'
                  : '1px dashed var(--cockpit-live-border)',
              }}
            >
              <span>{eq.manufacturer} {eq.model}</span>
              {eq.count > 1 && (
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--cockpit-live-badge-bg)', color: 'var(--cockpit-live-500)' }}
                >
                  &times;{eq.count}
                </span>
              )}
              {eq.specs?.cfm_typical && (
                <span className="text-[10px] font-medium" style={{ color: 'var(--cockpit-live-600)' }}>
                  {formatCfm(eq.specs.cfm_typical)}
                </span>
              )}
              {eq.specs?.confidence === 'unverified' && (
                <span title="Unverified specs — auto-fetched from web">&#x26A0;</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Sizing summary bar */}
      {sizing && (
        <div
          className="grid grid-cols-4 gap-2 px-4 py-3 text-center"
          style={{
            background: 'var(--cockpit-live-bg)',
            borderTop: '1px solid var(--cockpit-live-border)',
          }}
        >
          <div>
            <div className="text-[10px] font-medium" style={{ color: 'var(--cockpit-live-600)' }}>DEMAND</div>
            <div className="text-[15px] font-bold" style={{ color: 'var(--cockpit-live-900)' }}>
              {formatCfm(sizing.totalCfmAtDuty)}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-medium" style={{ color: 'var(--cockpit-live-600)' }}>PEAK</div>
            <div className="text-[15px] font-bold" style={{ color: 'var(--cockpit-live-900)' }}>
              {formatCfm(sizing.peakCfm)}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-medium" style={{ color: 'var(--cockpit-live-600)' }}>PRESSURE</div>
            <div className="text-[15px] font-bold" style={{ color: 'var(--cockpit-live-900)' }}>
              {sizing.maxPsi} PSI
            </div>
          </div>
          <div>
            <div className="text-[10px] font-medium" style={{ color: 'var(--cockpit-live-600)' }}>MACHINES</div>
            <div className="text-[15px] font-bold" style={{ color: 'var(--cockpit-live-900)' }}>
              {sizing.equipmentCount}
            </div>
          </div>
        </div>
      )}

      {/* CAS recommendation card */}
      {recommendation && recommendation.compressor && (
        <div
          className="px-4 py-4"
          style={{ borderTop: '1px solid var(--cockpit-live-border)' }}
        >
          <div
            className="text-[10px] font-bold tracking-widest mb-2"
            style={{ color: 'var(--cockpit-live-500)' }}
          >
            RECOMMENDED SYSTEM
          </div>

          {/* Compressor hero */}
          <div
            className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg"
            style={{
              background: 'var(--cockpit-live-bg)',
              border: '1px solid var(--cockpit-live-border)',
            }}
          >
            <div>
              <div className="text-[16px] font-bold" style={{ color: 'var(--cockpit-text)' }}>
                {recommendation.compressor.model}
              </div>
              <div className="text-[12px] mt-0.5" style={{ color: 'var(--cockpit-text-secondary)' }}>
                {recommendation.compressor.hp} HP &middot; {recommendation.compressor.cfm} CFM &middot; {recommendation.compressor.voltage || '460V/3ph'}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[18px] font-bold" style={{ color: 'var(--cockpit-live-500)' }}>
                {formatPrice(recommendation.compressor.price)}
              </div>
            </div>
          </div>

          {/* Dryer / filters */}
          {(recommendation.dryer || recommendation.filters?.length > 0) && (
            <div className="flex flex-wrap gap-2 mt-3">
              {recommendation.dryer && (
                <span
                  className="text-[11px] font-medium px-2.5 py-1 rounded-lg"
                  style={{
                    background: 'var(--cockpit-live-badge-bg)',
                    color: 'var(--cockpit-live-900)',
                    border: '1px solid var(--cockpit-live-border)',
                  }}
                >
                  + {recommendation.dryer.model}{recommendation.dryer.price != null ? ` (${formatPrice(recommendation.dryer.price)})` : ''}
                </span>
              )}
              {recommendation.filters?.map((f, i) => (
                <span
                  key={i}
                  className="text-[11px] font-medium px-2.5 py-1 rounded-lg"
                  style={{
                    background: 'var(--cockpit-live-badge-bg)',
                    color: 'var(--cockpit-live-900)',
                    border: '1px solid var(--cockpit-live-border)',
                  }}
                >
                  + {typeof f === 'string' ? f : `${f.model}${f.price != null ? ` (${formatPrice(f.price)})` : ''}`}
                </span>
              ))}
            </div>
          )}

          {/* Desiccant upgrade callout */}
          {recommendation.desiccantUpgrade && (
            <div
              className="mt-3 px-3 py-2 rounded-lg text-[11px] leading-relaxed"
              style={{
                background: 'var(--cockpit-amber-50)',
                border: '1px solid var(--cockpit-amber-100)',
                color: 'var(--cockpit-amber-900)',
              }}
            >
              <span className="font-bold">UPSELL:</span>{' '}
              {recommendation.desiccantUpgrade.model} desiccant dryer ({formatPrice(recommendation.desiccantUpgrade.price)})
              — molecular sieve media, {recommendation.desiccantUpgrade.dewpoint}°F dewpoint.
              Billet aluminum, wall mount, 1/3 size of conventional. For AS9100/pharma.
            </div>
          )}

          {/* Notes */}
          {recommendation.notes?.length > 0 && (
            <div className="mt-2">
              {(Array.isArray(recommendation.notes) ? recommendation.notes : [recommendation.notes]).map((note, i) => (
                <p key={i} className="text-[11px] leading-relaxed" style={{ color: 'var(--cockpit-text-muted)' }}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
