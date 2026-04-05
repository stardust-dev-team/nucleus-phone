import Tooltip from './Tooltip';

const COLORS = {
  green:  { bg: 'var(--cockpit-green-50, #052e16)', text: 'var(--cockpit-green-500, #22C55E)' },
  amber:  { bg: 'var(--cockpit-amber-50, #451a03)', text: 'var(--cockpit-amber-600, #D97706)' },
  violet: { bg: 'var(--cockpit-purple-50, #2e1065)', text: 'var(--cockpit-purple-500, #8B5CF6)' },
  red:    { bg: 'var(--cockpit-red-bg, #450a0a)', text: 'var(--cockpit-red-text, #DC2626)' },
  gray:   { bg: 'var(--cockpit-gray-100, #1c1917)', text: 'var(--cockpit-text-muted, #78716C)' },
};

export default function ScoreBadge({ label, color = 'gray', tooltip }) {
  if (!label) return null;
  const c = COLORS[color] || COLORS.gray;
  const badge = (
    <span
      className="inline-flex items-center px-2 py-[2px] rounded text-[10px] font-bold uppercase tracking-wider"
      style={{ background: c.bg, color: c.text }}
    >
      {label}
    </span>
  );
  return tooltip ? <Tooltip content={tooltip}>{badge}</Tooltip> : badge;
}
