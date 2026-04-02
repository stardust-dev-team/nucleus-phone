/**
 * DirectSaleCTA — Two call-to-action buttons for direct-sale recommendations.
 *
 * Shown when the sizing engine recommends a product with salesChannel: 'direct'.
 * CTA 1: Schedule audit with Alex (Slack callback).
 * CTA 2: Send custom quote via email (POST to /api/quote-request).
 */
import { useState } from 'react';

export default function DirectSaleCTA({ recommendation, contactName, contactCompany, contactPhone, callId }) {
  const [emailForm, setEmailForm] = useState(false);
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState(null); // null | 'sending' | 'sent' | 'error' | 'audit-sent'

  async function handleAuditRequest() {
    setStatus('sending');
    try {
      const res = await fetch('/api/quote-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          type: 'audit',
          callId,
          leadName: contactName,
          leadCompany: contactCompany,
          leadPhone: contactPhone,
          recommendation,
        }),
      });
      if (res.ok) setStatus('audit-sent');
      else setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  async function handleQuoteSubmit(e) {
    e.preventDefault();
    if (!consent || !email) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/quote-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          type: 'quote',
          callId,
          email,
          consent: true,
          leadName: contactName,
          leadCompany: contactCompany,
          leadPhone: contactPhone,
          recommendation,
        }),
      });
      if (res.ok) setStatus('sent');
      else setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'sent') {
    return (
      <div className="px-4 py-3 rounded-lg text-center" style={{ background: 'var(--cockpit-live-bg)', border: '1px solid var(--cockpit-live-border)' }}>
        <div className="text-[14px] font-bold" style={{ color: 'var(--cockpit-live-500)' }}>Quote request sent</div>
        <div className="text-[11px] mt-1" style={{ color: 'var(--cockpit-text-muted)' }}>We'll follow up at {email} with detailed pricing</div>
      </div>
    );
  }

  if (status === 'audit-sent') {
    return (
      <div className="px-4 py-3 rounded-lg text-center" style={{ background: 'var(--cockpit-live-bg)', border: '1px solid var(--cockpit-live-border)' }}>
        <div className="text-[14px] font-bold" style={{ color: 'var(--cockpit-live-500)' }}>Audit scheduled</div>
        <div className="text-[11px] mt-1" style={{ color: 'var(--cockpit-text-muted)' }}>Alex Paxton will follow up for a 10-minute compressed air audit</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Direct sale badge */}
      <div
        className="text-[10px] font-bold tracking-widest text-center py-1.5 rounded"
        style={{ background: 'var(--cockpit-amber-50)', color: 'var(--cockpit-amber-900)', border: '1px solid var(--cockpit-amber-100)' }}
      >
        DIRECT SALE — CUSTOM QUOTE REQUIRED
      </div>

      {/* CTA 1: Alex audit */}
      <button
        onClick={handleAuditRequest}
        disabled={status === 'sending'}
        className="w-full px-4 py-3 rounded-lg text-left transition-colors"
        style={{
          background: 'var(--cockpit-live-500)',
          color: '#FFFFFF',
          border: 'none',
          cursor: status === 'sending' ? 'wait' : 'pointer',
          opacity: status === 'sending' ? 0.7 : 1,
        }}
      >
        <div className="text-[13px] font-bold">Schedule 10-Min Compressed Air Audit</div>
        <div className="text-[11px] mt-0.5" style={{ opacity: 0.8 }}>with Alex Paxton, System Specialist</div>
      </button>

      {/* CTA 2: Email quote */}
      {!emailForm ? (
        <button
          onClick={() => setEmailForm(true)}
          disabled={status === 'sending'}
          className="w-full px-4 py-3 rounded-lg text-left transition-colors"
          style={{
            background: 'transparent',
            color: 'var(--cockpit-live-500)',
            border: '1px solid var(--cockpit-live-border)',
            cursor: 'pointer',
          }}
        >
          <div className="text-[13px] font-bold">Send Custom Quote via Email</div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--cockpit-text-muted)' }}>We'll follow up with detailed pricing</div>
        </button>
      ) : (
        <form onSubmit={handleQuoteSubmit} className="px-4 py-3 rounded-lg space-y-2" style={{ background: 'var(--cockpit-live-bg)', border: '1px solid var(--cockpit-live-border)' }}>
          <input
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Lead's email address"
            className="w-full px-3 py-2 rounded text-[13px]"
            style={{ background: 'var(--cockpit-card)', border: '1px solid var(--cockpit-live-border)', color: 'var(--cockpit-text)' }}
          />
          <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--cockpit-text-secondary)' }}>
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
            Lead gave permission to receive a quote via email
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!consent || !email || status === 'sending'}
              className="flex-1 px-3 py-2 rounded text-[12px] font-bold"
              style={{
                background: consent && email ? 'var(--cockpit-live-500)' : 'var(--cockpit-live-border)',
                color: '#FFFFFF',
                border: 'none',
                cursor: consent && email ? 'pointer' : 'not-allowed',
              }}
            >
              {status === 'sending' ? 'Sending...' : 'Send Quote Request'}
            </button>
            <button
              type="button"
              onClick={() => setEmailForm(false)}
              className="px-3 py-2 rounded text-[12px]"
              style={{ background: 'transparent', color: 'var(--cockpit-text-muted)', border: '1px solid var(--cockpit-live-border)' }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {status === 'error' && (
        <div className="text-[11px] text-center" style={{ color: 'var(--cockpit-error)' }}>
          Failed to send — please follow up manually
        </div>
      )}
    </div>
  );
}
