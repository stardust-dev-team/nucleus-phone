/**
 * LiveAnalysis — Real-time equipment detection, air demand sizing, and CAS
 * product recommendation widget.  Blue accent color to distinguish from the
 * purple practice-call UI.
 *
 * Progressive phases:
 *   1. Listening  — pulsing dot, no equipment yet
 *   2. Equipment  — badges per detected machine
 *   3. Sizing     — aggregated CFM / PSI bar
 *   4. Recommend  — CAS compressor card
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
  if (!active && !connected && equipment.length === 0) return null;

  const detected = hasEquipment(safe);

  return (
    <div
      className="mt-3 rounded-lg overflow-hidden transition-all duration-300"
      style={{
        border: `1px solid var(--cockpit-blue-border)`,
        background: 'var(--cockpit-card)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{
          background: 'var(--cockpit-blue-bg)',
          borderBottom: detected ? '1px solid var(--cockpit-blue-border)' : 'none',
        }}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            background: connected ? 'var(--cockpit-blue-500)' : 'var(--cockpit-text-muted)',
            animation: connected ? 'live-pulse 2s ease-in-out infinite' : 'none',
          }}
        />
        <span className="text-[12px] font-medium" style={{ color: 'var(--cockpit-blue-900)' }}>
          {!detected
            ? 'Listening for equipment...'
            : `${equipment.length} ${equipment.length === 1 ? 'machine' : 'machines'} detected`}
        </span>
      </div>

      {/* Equipment list */}
      {equipment.length > 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-1.5">
          {equipment.map((eq, i) => (
            <span
              key={`${eq.manufacturer}-${eq.model}-${i}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium"
              style={{
                background: 'var(--cockpit-blue-bg)',
                color: 'var(--cockpit-blue-900)',
                border: eq.catalogMatch ? 'none' : '1px dashed var(--cockpit-blue-border)',
              }}
            >
              <span>{eq.manufacturer} {eq.model}</span>
              {eq.count > 1 && <span style={{ opacity: 0.7 }}>&times;{eq.count}</span>}
              {eq.specs?.cfm_typical && (
                <span style={{ color: 'var(--cockpit-text-muted)', fontSize: '10px' }}>
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
          className="flex items-center justify-between px-3 py-2 text-[11px]"
          style={{
            background: 'var(--cockpit-blue-bg)',
            borderTop: '1px solid var(--cockpit-blue-border)',
          }}
        >
          <span style={{ color: 'var(--cockpit-blue-900)' }}>
            Total: <strong>{formatCfm(sizing.totalCfmAtDuty)}</strong> @ duty
          </span>
          <span style={{ color: 'var(--cockpit-blue-900)' }}>
            Peak: <strong>{formatCfm(sizing.peakCfm)}</strong>
          </span>
          <span style={{ color: 'var(--cockpit-blue-900)' }}>
            {sizing.maxPsi} PSI
          </span>
          <span style={{ color: 'var(--cockpit-text-muted)' }}>
            {sizing.equipmentCount} machines
          </span>
        </div>
      )}

      {/* CAS recommendation card */}
      {recommendation && recommendation.compressor && (
        <div
          className="px-3 py-2.5"
          style={{ borderTop: '1px solid var(--cockpit-blue-border)' }}
        >
          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--cockpit-blue-500)' }}>
            RECOMMENDED SYSTEM
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[14px] font-bold" style={{ color: 'var(--cockpit-text)' }}>
                {recommendation.compressor.model}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--cockpit-text-secondary)' }}>
                {recommendation.compressor.hp} HP &middot; {recommendation.compressor.cfm} CFM
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[14px] font-bold" style={{ color: 'var(--cockpit-blue-500)' }}>
                {formatPrice(recommendation.compressor.price)}
              </div>
            </div>
          </div>

          {/* Dryer / filters */}
          {(recommendation.dryer || recommendation.filters?.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {recommendation.dryer && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--cockpit-blue-bg)', color: 'var(--cockpit-blue-900)' }}
                >
                  + {recommendation.dryer.model}{recommendation.dryer.price != null ? ` (${formatPrice(recommendation.dryer.price)})` : ''}
                </span>
              )}
              {recommendation.filters?.map((f, i) => (
                <span
                  key={i}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--cockpit-blue-bg)', color: 'var(--cockpit-blue-900)' }}
                >
                  + {f}
                </span>
              ))}
            </div>
          )}

          {/* Notes */}
          {recommendation.notes && (
            <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'var(--cockpit-text-muted)' }}>
              {recommendation.notes}
            </p>
          )}
        </div>
      )}

    </div>
  );
}
