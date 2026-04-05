import { useState } from 'react';

function Section({ label, items, renderItem }) {
  if (!items?.length) return null;
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-semibold text-cp-text-muted uppercase tracking-wider">{label}</span>
        <span className="text-[10px] text-cp-text-muted">({items.length})</span>
      </div>
      {items.map((item, i) => (
        <div key={i} className="text-xs text-cp-text leading-relaxed py-0.5">
          {renderItem ? renderItem(item) : `• ${item}`}
        </div>
      ))}
    </div>
  );
}

function TextBlock({ label, text, maxChars = 300 }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const truncated = text.length > maxChars && !expanded;

  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[10px] font-semibold text-cp-text-muted uppercase tracking-wider mb-1">{label}</div>
      <p className="text-xs text-cp-text-secondary leading-relaxed">
        {truncated ? text.substring(0, maxChars) + '...' : text}
      </p>
      {text.length > maxChars && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] font-medium mt-0.5"
          style={{ color: 'var(--cockpit-blue-500, #3B82F6)' }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export default function CompanyVernacular({ vernacular }) {
  const [open, setOpen] = useState(true);
  if (!vernacular || vernacular.sourceCount === 0) return null;

  const hasLists = vernacular.equipment?.length || vernacular.painPoints?.length
    || vernacular.competitorsMentioned?.length || vernacular.productsDiscussed?.length;
  const hasText = vernacular.hubspotVernacular || vernacular.tenKInsights
    || vernacular.capitalEquipment || vernacular.complianceContext;

  if (!hasLists && !hasText && !vernacular.certContext && !vernacular.leadershipStrategy) return null;

  return (
    <div className="mb-3">
      <div
        className="flex justify-between items-center cursor-pointer"
        style={{ marginBottom: open ? 6 : 0 }}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-[1.5px]">
            Company vernacular
          </span>
          <span
            className="text-[9px] font-bold px-1.5 py-[1px] rounded"
            style={{
              background: 'var(--cockpit-amber-50)',
              color: 'var(--cockpit-amber-600)',
            }}
          >
            {vernacular.sourceCount} source{vernacular.sourceCount !== 1 ? 's' : ''}
          </span>
        </div>
        <span className="text-xs text-cp-text-muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="rounded py-2.5 px-3.5 bg-cp-card border border-cp-border">
          {/* Cert context — always prominent */}
          {vernacular.certContext && (
            <div className="text-xs text-cp-text mb-2 pb-2" style={{ borderBottom: '1px solid var(--cockpit-card-border)' }}>
              <span className="font-semibold">Certification:</span> {vernacular.certContext}
            </div>
          )}

          {/* Leadership strategy — one-liner */}
          {vernacular.leadershipStrategy && (
            <div className="text-xs text-cp-text mb-2 pb-2" style={{ borderBottom: '1px solid var(--cockpit-card-border)' }}>
              <span className="font-semibold">Strategy:</span> {vernacular.leadershipStrategy}
            </div>
          )}

          {/* Structured lists */}
          <Section label="Equipment" items={vernacular.equipment} />
          <Section label="Pain points" items={vernacular.painPoints} />
          <Section label="Competitors" items={vernacular.competitorsMentioned} />
          <Section label="Products discussed" items={vernacular.productsDiscussed} />

          {/* Long-form text blocks */}
          <TextBlock label="Compliance" text={vernacular.complianceContext} maxChars={200} />
          <TextBlock label="10-K insights" text={vernacular.tenKInsights} />
          <TextBlock label="Capital equipment" text={vernacular.capitalEquipment} maxChars={200} />
          <TextBlock label="Internal vernacular" text={vernacular.hubspotVernacular} />
        </div>
      )}
    </div>
  );
}
