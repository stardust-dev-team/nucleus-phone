import ScoreBadge from '../ui/ScoreBadge';
import Tooltip from '../ui/Tooltip';

function tenureBadge(durationStr) {
  if (!durationStr) return null;
  const months = parseInt(durationStr, 10);
  if (isNaN(months)) return { label: durationStr, color: 'gray', tooltip: null };
  if (months <= 6) return { label: 'New in role', color: 'violet', tooltip: `${durationStr} — may be evaluating vendors and building relationships` };
  if (months <= 24) return { label: 'Settling in', color: 'amber', tooltip: `${durationStr} — knows the operation, still open to changes` };
  return { label: 'Established', color: 'green', tooltip: `${durationStr} — deep operational knowledge, harder to switch` };
}

export default function CareerContext({ pbContactData }) {
  if (!pbContactData) return null;
  const { summary, durationInRole, pastExperience } = pbContactData;
  if (!summary && !durationInRole && !pastExperience) return null;

  const tenure = tenureBadge(durationInRole);

  return (
    <div className="mb-3">
      <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-[1.5px] mb-1.5">
        Career context
      </div>
      <div
        className="rounded-r py-3 px-3.5 bg-cp-card border border-cp-border"
        style={{ borderLeft: '4px solid var(--cockpit-blue-500, #3B82F6)' }}
      >
        {/* Tenure badge */}
        {tenure && (
          <div className="flex items-center gap-2 mb-2">
            <ScoreBadge label={tenure.label} color={tenure.color} tooltip={tenure.tooltip} />
            {durationInRole && !tenure.tooltip && (
              <span className="text-xs text-cp-text-muted">{durationInRole}</span>
            )}
          </div>
        )}

        {/* Past experience */}
        {pastExperience && (
          <div className="text-xs text-cp-text-secondary mb-2">
            <Tooltip content={
              typeof pastExperience === 'object'
                ? `${pastExperience.title} at ${pastExperience.company}${pastExperience.duration ? ` (${pastExperience.duration})` : ''}`
                : pastExperience
            }>
              <span className="cursor-help">
                Prev: {typeof pastExperience === 'object'
                  ? `${pastExperience.title} at ${pastExperience.company}`
                  : pastExperience}
              </span>
            </Tooltip>
          </div>
        )}

        {/* LinkedIn summary */}
        {summary && (
          <p className="text-xs text-cp-text-muted leading-relaxed line-clamp-3">
            {summary}
          </p>
        )}
      </div>
    </div>
  );
}
