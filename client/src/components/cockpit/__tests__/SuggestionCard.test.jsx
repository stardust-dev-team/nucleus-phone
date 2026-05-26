import { render, screen } from '@testing-library/react';
import SuggestionCard from '../SuggestionCard';

// SuggestionCard was redesigned in commit 4f6de78 ("Persist last 5 suggestions
// + shrink equipment listener") to be a passive history entry: no auto-dismiss
// timer, no dismiss button, no onDismiss prop. The parent (ConversationNavigator)
// owns the lifecycle and renders the last N entries with a fade. The old test
// suite covered timer/dismiss behavior that no longer exists; those tests were
// stale and have been removed. The two tests below pin the surface that
// remains: text + source badge rendering, and the data-trigger attribute for
// styling/test hooks.
describe('SuggestionCard', () => {
  test('renders suggestion text and source badge', () => {
    render(
      <SuggestionCard
        suggestion={{ text: 'Ask about their maintenance schedule', source: 'prediction', _receivedAt: 1 }}
      />
    );
    expect(screen.getByText(/maintenance schedule/)).toBeInTheDocument();
    expect(screen.getByText(/predicted/i)).toBeInTheDocument();
  });

  test('trigger value is exposed via data-trigger for styling hooks/tests', () => {
    const exit = render(
      <SuggestionCard
        suggestion={{ text: 'Graceful exit', trigger: 'exit_assist', _receivedAt: 1 }}
      />
    );
    expect(exit.container.firstChild.getAttribute('data-trigger')).toBe('exit_assist');

    const objection = render(
      <SuggestionCard
        suggestion={{ text: 'Rebuttal', trigger: 'objection', _receivedAt: 2 }}
      />
    );
    expect(objection.container.firstChild.getAttribute('data-trigger')).toBe('objection');

    const plain = render(
      <SuggestionCard
        suggestion={{ text: 'Ask about budget', _receivedAt: 3 }}
      />
    );
    expect(plain.container.firstChild.getAttribute('data-trigger')).toBe('default');
  });
});
