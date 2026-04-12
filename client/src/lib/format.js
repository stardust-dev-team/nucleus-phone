export function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ── Activity tab helpers ─────────────────────────────────────────

// Returns a bucket key: 'today' | 'yesterday' | 'thisWeek' | 'earlier'.
// Used by Activity.jsx to group cards under date headings.
export function dateBucket(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 6); // 7 days rolling window

  if (d >= startOfToday) return 'today';
  if (d >= startOfYesterday) return 'yesterday';
  if (d >= startOfWeek) return 'thisWeek';
  return 'earlier';
}

export const DATE_BUCKET_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  earlier: 'Earlier',
};

export const DATE_BUCKET_ORDER = ['today', 'yesterday', 'thisWeek', 'earlier'];

// Turn a disposition enum ("qualified_hot") into display text ("qualified hot").
export function humanizeDisposition(disposition) {
  if (!disposition) return '';
  return disposition.replace(/_/g, ' ');
}

// Minute-granularity relative format: "2m ago" / "Yesterday 3:42 PM" / "Mar 25".
// Uses day-boundary comparisons (not getDate() equality) to avoid labeling
// same-day-of-month past dates as "Yesterday".
export function formatRelativeTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  if (d >= startOfToday) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d >= startOfYesterday) {
    return 'Yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Day-granularity variant: "Today" / "Yesterday" / "3d ago" / "2w ago" / "Mar 25".
// Used by cockpit cards where minute-level precision is noise.
export function formatRelativeDay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
