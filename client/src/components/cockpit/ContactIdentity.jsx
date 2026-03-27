export default function ContactIdentity({ identity }) {
  const name = identity?.name || 'Unknown Contact';
  const title = identity?.title || '';
  const company = identity?.company || '';
  const photo = identity?.profileImage;
  const linkedinUrl = identity?.linkedinUrl;

  const initials = name
    .split(' ')
    .filter(Boolean)
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
            <a href={linkedinUrl} target="_blank" rel="noreferrer" className="inline-flex" style={{ color: 'var(--cockpit-blue-500)' }}>
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
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
