export default function RapportOpener({ openingLine }) {
  if (!openingLine) return null;

  return (
    <div
      className="rounded-r-lg py-3.5 px-4 mb-4 transition-colors duration-300"
      style={{
        background: 'var(--cockpit-amber-50)',
        borderLeft: '4px solid var(--cockpit-amber-600)',
      }}
    >
      <div className="flex items-start gap-2.5">
        <span className="text-lg shrink-0 mt-0.5">🎯</span>
        <div>
          <div
            className="text-[11px] font-semibold uppercase tracking-wider mb-1"
            style={{ color: 'var(--cockpit-amber-600)' }}
          >
            Suggested opener
          </div>
          <div
            className="text-base font-medium leading-[1.45]"
            style={{ color: 'var(--cockpit-amber-900)' }}
          >
            {openingLine}
          </div>
        </div>
      </div>
    </div>
  );
}
