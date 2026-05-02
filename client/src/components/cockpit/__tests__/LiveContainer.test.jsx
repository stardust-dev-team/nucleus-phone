import { render, screen } from '@testing-library/react';
import LiveContainer from '../LiveContainer';

// Stub LiveAnalysis — we're testing the layering, not the equipment widget
jest.mock('../LiveAnalysis', () => () => <div data-testid="live-analysis" />);
jest.mock('../DirectSaleCTA', () => () => null);

describe('LiveContainer', () => {
  const baseData = {
    equipment: [],
    sizing: null,
    recommendation: null,
    connected: false,
    phase: { phase: 'discovery', key_topic: 'current compressor' },
    sentiment: { customer: 'positive', momentum: 'building', history: [{ customer: 'positive' }] },
    suggestionHistory: [],
    objection: null,
    navigatorStatus: 'ok',
  };

  test('always renders LiveAnalysis', () => {
    render(<LiveContainer data={baseData} navigatorEnabled={false} />);
    expect(screen.getByTestId('live-analysis')).toBeInTheDocument();
  });

  test('navigator enabled: renders phase indicator', () => {
    render(<LiveContainer data={baseData} navigatorEnabled={true} />);
    expect(screen.getByText(/Discovery/)).toBeInTheDocument();
    expect(screen.getByText(/current compressor/)).toBeInTheDocument();
  });

  test('navigator disabled: no phase indicator', () => {
    render(<LiveContainer data={baseData} navigatorEnabled={false} />);
    expect(screen.queryByText(/Discovery/)).not.toBeInTheDocument();
  });

  test('suggestion renders when present in history', () => {
    const data = { ...baseData, suggestionHistory: [{ text: 'Ask about budget', _seq: 1 }] };
    render(<LiveContainer data={data} navigatorEnabled={true} />);
    expect(screen.getByText(/Ask about budget/)).toBeInTheDocument();
  });

  test('degraded status shows limited label', () => {
    const data = { ...baseData, navigatorStatus: 'degraded' };
    render(<LiveContainer data={data} navigatorEnabled={true} />);
    expect(screen.getByText(/Navigator limited/i)).toBeInTheDocument();
  });
});
