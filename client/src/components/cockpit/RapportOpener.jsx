export default function RapportOpener({ openingLine }) {
  if (!openingLine) return null;

  return (
    <div
      className="rounded-r-lg py-2.5 px-3 mb-2 transition-colors duration-300"
      style={{
        background: 'var(--cockpit-amber-50)',
        borderLeft: '3px solid var(--cockpit-amber-600)',
      }}
    >
      <div className="flex items-start gap-2">
        <span className="text-base shrink-0">🎯</span>
        <div>
          <div
            className="text-[10px] font-semibold uppercase tracking-wider mb-0.5"
            style={{ color: 'var(--cockpit-amber-600)' }}
          >
            Suggested opener
          </div>
          <div
            className="text-[14px] font-medium leading-[1.35]"
            style={{ color: 'var(--cockpit-amber-900)' }}
          >
            {openingLine}
          </div>
        </div>
      </div>
    </div>
  );
}
