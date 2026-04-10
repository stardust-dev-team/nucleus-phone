import { useState, useRef, useEffect } from 'react';
import useAskNucleus from '../hooks/useAskNucleus';

const SUGGESTED_PROMPTS = [
  { label: 'What did my last call cover?', text: 'Summarize my most recent call.' },
  { label: 'JRS-10E specs', text: 'What are the specs and price for the JRS-10E?' },
  { label: 'Recent objections', text: 'What objections have come up in my calls this week?' },
  { label: 'AS9100 recommendation', text: 'What should I recommend for an AS9100 aerospace customer?' },
];

const TOOL_LABELS = {
  search_my_calls: 'Searching your calls...',
  search_interactions: 'Searching interactions...',
  get_product_specs: 'Looking up product specs...',
  get_company_history: 'Loading company history...',
};

function ToolStatusIndicator({ toolName }) {
  if (!toolName) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-jv-muted italic px-4 py-2">
      <div className="w-1.5 h-1.5 rounded-full bg-jv-amber animate-pulse" />
      <span>{TOOL_LABELS[toolName] || `Running ${toolName}...`}</span>
    </div>
  );
}

function EscalationButton({ escalation, onEscalate }) {
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [channels, setChannels] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);

  async function handleClick() {
    setStatus('sending');
    setErrorMsg(null);
    try {
      const result = await onEscalate(escalation);
      if (result.sent) {
        setStatus('sent');
        setChannels(result.channels || []);
      } else {
        setStatus('error');
        setErrorMsg('Delivery failed');
      }
    } catch (err) {
      setStatus('error');
      if (err.message?.includes('429') || err.message?.includes('rate_limited')) {
        setErrorMsg('Rate limited — wait a few minutes before escalating again.');
      } else {
        setErrorMsg('Failed to reach Tom');
      }
    }
  }

  if (status === 'sent') {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg bg-jv-green/10 border border-jv-green/30 text-xs text-jv-green">
        Sent to Tom via {channels.join(' + ')}. He'll see it on his phone.
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg bg-jv-red/10 border border-jv-red/30 text-xs text-jv-red">
        {errorMsg || 'Error sending to Tom'}
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={status === 'sending'}
      className="mt-2 px-3 py-2 rounded-lg bg-jv-amber/10 border border-jv-amber/40 text-xs text-jv-amber hover:bg-jv-amber/20 transition-colors disabled:opacity-50"
    >
      {status === 'sending' ? 'Sending...' : 'Send to Tom'}
    </button>
  );
}

function Message({ message, onEscalate }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div
          className={`px-4 py-2 rounded-2xl ${
            isUser
              ? 'bg-jv-amber/20 border border-jv-amber/40 text-white rounded-br-sm'
              : 'bg-jv-card border border-jv-border text-jv-bone rounded-bl-sm'
          }`}
        >
          {message.content ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="flex gap-1 items-center py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-jv-muted animate-pulse" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-jv-muted animate-pulse" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-jv-muted animate-pulse" style={{ animationDelay: '300ms' }} />
            </div>
          )}
        </div>
        {!isUser && message.escalation && !message.streaming && (
          <EscalationButton escalation={message.escalation} onEscalate={onEscalate} />
        )}
      </div>
    </div>
  );
}

function EmptyState({ onSelect }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center">
      <div className="mb-6">
        <h2 className="text-xl font-semibold mb-2">Ask Nucleus</h2>
        <p className="text-sm text-jv-muted max-w-sm">
          Ask about your calls, products, customers, or anything about Joruva Industrial.
          If I can't answer, I'll offer to escalate to Tom.
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full max-w-sm">
        {SUGGESTED_PROMPTS.map((p, i) => (
          <button
            key={i}
            onClick={() => onSelect(p.text)}
            className="text-left px-4 py-3 rounded-xl bg-jv-card border border-jv-border text-sm text-jv-bone hover:border-jv-amber/40 transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AskNucleus() {
  const { messages, isLoading, toolStatus, error, sendMessage, clearHistory, escalate } = useAskNucleus();
  const [input, setInput] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom on new messages. Use 'auto' during streaming to
  // avoid fighting the browser's smooth-scroll animation on every token.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: isLoading ? 'auto' : 'smooth',
    });
  }, [messages, toolStatus, isLoading]);

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;
    const text = input;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const ok = await sendMessage(text);
    if (!ok) {
      // Restore the user's typed text on failure so they don't have to retype
      setInput(text);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-jv-border shrink-0">
        <h2 className="text-lg font-semibold">Ask Nucleus</h2>
        {messages.length > 0 && (
          <button
            onClick={clearHistory}
            className="text-xs text-jv-muted hover:text-white transition-colors"
          >
            New chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-container p-4">
        {messages.length === 0 ? (
          <EmptyState onSelect={(text) => { setInput(text); inputRef.current?.focus(); }} />
        ) : (
          <>
            {/* key={i} is safe because messages is append-only. If the server
                ever returns stable message IDs, switch to those. */}
            {messages.map((msg, i) => (
              <Message key={i} message={msg} onEscalate={escalate} />
            ))}
            <ToolStatusIndicator toolName={toolStatus} />
            {error && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-jv-red/10 border border-jv-red/30 text-xs text-jv-red">
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-jv-border shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-grow up to max-h-32 (~5 rows), then internal scroll takes over
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
            }}
            onKeyDown={handleKeyDown}
            placeholder={isLoading ? 'Nucleus is thinking...' : 'Ask me anything... (Shift+Enter for newline)'}
            disabled={isLoading}
            rows={1}
            className="flex-1 bg-jv-card border border-jv-border rounded-lg px-4 py-2 text-sm text-white placeholder:text-jv-muted focus:outline-none focus:border-jv-amber/50 disabled:opacity-50 resize-none max-h-32 overflow-y-auto"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="px-4 py-2 rounded-lg bg-jv-amber text-black text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
