export default function RapportTags({ tags }) {
  if (!tags?.length) return null;

  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {tags.map((tag, i) => {
        const text = typeof tag === 'string' ? tag : tag.text || tag;
        const icon = typeof tag === 'object' ? tag.icon : null;
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2.5 py-[3px] rounded-2xl text-xs font-medium"
            style={{
              background: 'var(--cockpit-amber-50)',
              color: 'var(--cockpit-amber-900)',
              border: '1px solid var(--cockpit-amber-100)',
            }}
          >
            {icon && <span className="text-[13px]">{icon}</span>}
            {text}
          </span>
        );
      })}
    </div>
  );
}
