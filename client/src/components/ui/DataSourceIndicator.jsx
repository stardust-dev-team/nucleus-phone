import Tooltip from './Tooltip';

const SOURCES = [
  { key: 'pb', label: 'PB', tooltip: 'PhantomBuster LinkedIn profile' },
  { key: 'signal', label: 'Signal', tooltip: 'Signal engine (cert, DoD, contracts)' },
  { key: 'hubspot', label: 'HS', tooltip: 'HubSpot CRM company data' },
  { key: 'email', label: 'Email', tooltip: 'Email engagement (opens, clicks)' },
  { key: 'calls', label: 'Calls', tooltip: 'Prior phone call history' },
];

export default function DataSourceIndicator({ sources = {} }) {
  return (
    <div className="flex gap-1.5 items-center">
      {SOURCES.map(({ key, label, tooltip }) => {
        const active = !!sources[key];
        return (
          <Tooltip key={key} content={`${tooltip}: ${active ? 'data available' : 'no data'}`}>
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded transition-colors"
              style={{
                background: active ? 'var(--cockpit-green-50, #052e16)' : 'transparent',
                color: active ? 'var(--cockpit-green-500, #22C55E)' : 'var(--cockpit-text-muted, #78716C)',
                border: `1px solid ${active ? 'var(--cockpit-green-500-20, rgba(34,197,94,0.2))' : 'var(--cockpit-card-border, rgba(49,46,129,0.3))'}`,
                opacity: active ? 1 : 0.5,
              }}
            >
              {label}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
