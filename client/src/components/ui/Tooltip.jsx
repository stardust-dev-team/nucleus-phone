import * as T from '@radix-ui/react-tooltip';

export function TooltipProvider({ children }) {
  return <T.Provider delayDuration={300}>{children}</T.Provider>;
}

export default function Tooltip({ children, content, side = 'top' }) {
  if (!content) return children;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={4}
          className="z-50 max-w-xs rounded px-3 py-2 text-xs leading-relaxed shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{
            background: 'var(--cockpit-card, #0F0D29)',
            color: 'var(--cockpit-text, #F5F5F4)',
            border: '1px solid var(--cockpit-card-border, rgba(49,46,129,0.5))',
          }}
        >
          {content}
          <T.Arrow
            width={8}
            height={4}
            style={{ fill: 'var(--cockpit-card, #0F0D29)' }}
          />
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
