export default function ContactIdentity({ identity }) {
  const name = identity?.name || 'Unknown Contact';
  const title = identity?.title || '';
  const company = identity?.company || '';
  const photo = identity?.profileImage;
  const linkedinUrl = identity?.linkedinUrl;

  const initials = name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex items-center gap-3.5 mb-4">
      {photo ? (
        <img src={photo} alt={name} className="w-14 h-14 rounded-full object-cover shrink-0" />
      ) : (
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-semibold shrink-0"
          style={{ background: `linear-gradient(135deg, var(--cockpit-amber-600), var(--cockpit-orange-500))` }}
        >
          {initials}
        </div>
      )}
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[22px] font-medium text-cp-text">{name}</span>
          {linkedinUrl && (
            <a href={linkedinUrl} target="_blank" rel="noreferrer" className="text-sm" style={{ color: 'var(--cockpit-blue-500)' }}>
              🔗
            </a>
          )}
        </div>
        <span className="text-sm text-cp-text-secondary">
          {title}{title && company ? ' · ' : ''}{company}
        </span>
      </div>
    </div>
  );
}
