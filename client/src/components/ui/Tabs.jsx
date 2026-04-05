import * as T from '@radix-ui/react-tabs';

export function Tabs({ value, onValueChange, children, className = '' }) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={className}>
      {children}
    </T.Root>
  );
}

export function TabsList({ children }) {
  return (
    <T.List
      className="flex gap-1 px-1 py-1 rounded-lg"
      style={{ background: 'var(--cockpit-card, #0F0D29)' }}
    >
      {children}
    </T.List>
  );
}

export function TabsTrigger({ value, children }) {
  return (
    <T.Trigger
      value={value}
      className="px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-wider transition-colors
                 data-[state=active]:text-white data-[state=inactive]:text-cp-text-muted
                 data-[state=active]:bg-jv-amber/20"
      style={{
        borderBottom: 'var(--tab-active-border, none)',
      }}
    >
      {children}
    </T.Trigger>
  );
}

export function TabsContent({ value, children }) {
  return (
    <T.Content value={value} className="outline-none">
      {children}
    </T.Content>
  );
}
