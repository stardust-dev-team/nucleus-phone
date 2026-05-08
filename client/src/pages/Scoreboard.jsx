import useScoreboard from '../hooks/useScoreboard';

function Sparkline({ data, max }) {
  if (!data.length) return null;
  const h = 24;
  const w = 80;
  const step = w / Math.max(data.length - 1, 1);
  const scale = max > 0 ? h / max : 1;
  const points = data.map((d, i) => `${i * step},${h - d.calls * scale}`).join(' ');

  return (
    <svg width={w} height={h} className="shrink-0">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function StatBadge({ label, value, color }) {
  return (
    <div className="flex flex-col items-center">
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      <span className="text-xs text-aunshin-quiet-d">{label}</span>
    </div>
  );
}

function RankBadge({ rank }) {
  const badges = ['🥇', '🥈', '🥉'];
  if (rank < 3) return <span className="text-2xl">{badges[rank]}</span>;
  return <span className="text-lg text-aunshin-quiet-d font-bold">#{rank + 1}</span>;
}

function AgentCard({ agent, rank }) {
  const maxCalls = Math.max(...agent.daily.map(d => d.calls), 1);

  return (
    <div className="bg-aunshin-twilight-2 border border-aunshin-rule-d rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <RankBadge rank={rank} />
          <div>
            <p className="font-semibold">{agent.displayName}</p>
            <p className="text-xs text-aunshin-quiet-d">{agent.callsMade} calls this week</p>
          </div>
        </div>
        <Sparkline data={agent.daily} max={maxCalls} />
      </div>

      <div className="flex justify-around pt-3 border-t border-aunshin-rule-d">
        <StatBadge label="Qualified" value={agent.leadsQualified} color="text-aunshin-success" />
        <StatBadge label="Hot" value={agent.hotLeads} color="text-aunshin-alert" />
        <StatBadge label="Callbacks" value={agent.callbacks} color="text-aunshin-sodium" />
        <StatBadge label="Avg min" value={agent.avgDuration ? Math.round(agent.avgDuration / 60) : 0} color="text-aunshin-sodium" />
      </div>
    </div>
  );
}

export default function Scoreboard() {
  const { data, loading, error } = useScoreboard();

  if (loading) {
    return (
      <div className="p-4 space-y-4 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-28 bg-aunshin-twilight-2 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-aunshin-alert">{error}</p>
      </div>
    );
  }

  const leaderboard = data?.leaderboard || [];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold">Team Scoreboard</h1>
        <p className="text-sm text-aunshin-quiet-d">Rolling 7-day performance</p>
      </div>

      <div className="flex-1 overflow-y-auto scroll-container px-4 space-y-3 pb-4">
        {leaderboard.length === 0 && (
          <p className="text-center text-aunshin-quiet-d py-8">No calls recorded yet</p>
        )}
        {leaderboard.map((agent, i) => (
          <AgentCard key={agent.identity} agent={agent} rank={i} />
        ))}
      </div>
    </div>
  );
}
