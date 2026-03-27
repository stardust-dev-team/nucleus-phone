import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import useContacts from '../hooks/useContacts';

const FILTERS = ['All', 'Never Called', 'Callback Pending', 'Hot'];

const TEST_CONTACT = {
  id: 'test-call',
  properties: {
    firstname: 'Mike',
    lastname: 'Garza',
    phone: '+16026419729',
    company: 'Garza Precision Machine',
    jobtitle: 'Owner / Shop Manager',
  },
  callHistory: { callCount: 2, lastCall: new Date(Date.now() - 8 * 86400000).toISOString(), lastDisposition: 'callback_requested' },
  _isTest: true,
};

function dispositionDot(callHistory) {
  if (!callHistory) return 'bg-gray-500';
  switch (callHistory.lastDisposition) {
    case 'qualified_hot': return 'bg-jv-red';
    case 'qualified_warm': return 'bg-jv-amber';
    case 'callback_requested': return 'bg-jv-amber';
    case 'connected': return 'bg-jv-green';
    case 'not_interested': return 'bg-jv-red';
    default: return 'bg-jv-green';
  }
}

function callBadge(callHistory) {
  if (!callHistory) return { text: 'Never called', cls: 'text-gray-500' };
  const days = Math.floor((Date.now() - new Date(callHistory.lastCall).getTime()) / 86400000);
  if (days === 0) return { text: 'Called today', cls: 'text-jv-green' };
  if (days === 1) return { text: 'Called yesterday', cls: 'text-jv-green' };
  return { text: `Called ${days}d ago`, cls: 'text-jv-muted' };
}

export default function Contacts({ identity, callState, twilioStatus }) {
  const { contacts, loading, error, fetchContacts } = useContacts();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(() => sessionStorage.getItem('contacts_filter') || 'All');
  const navigate = useNavigate();
  const listRef = useRef(null);

  useEffect(() => {
    fetchContacts('');
  }, [fetchContacts]);

  // Restore scroll position on mount (back from cockpit)
  useEffect(() => {
    if (!loading && listRef.current) {
      const saved = sessionStorage.getItem('contacts_scroll');
      if (saved) listRef.current.scrollTop = parseInt(saved, 10);
    }
  }, [loading]);

  // Persist filter changes
  useEffect(() => {
    sessionStorage.setItem('contacts_filter', filter);
  }, [filter]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.length >= 2 || search.length === 0) {
        fetchContacts(search);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [search, fetchContacts]);

  function handleCockpit(contact) {
    // Save scroll position before navigating
    if (listRef.current) {
      sessionStorage.setItem('contacts_scroll', String(listRef.current.scrollTop));
    }
    navigate(`/cockpit/${contact.id}`);
  }

  async function handleCall(contact) {
    if (twilioStatus !== 'ready') return;
    try {
      await callState.startCall(contact, identity);
      navigate('/dialer');
    } catch (err) {
      alert('Call failed: ' + err.message);
    }
  }

  const filtered = contacts.filter((c) => {
    if (filter === 'All') return true;
    if (filter === 'Never Called') return !c.callHistory;
    if (filter === 'Callback Pending') return c.callHistory?.lastDisposition === 'callback_requested';
    if (filter === 'Hot') return c.callHistory?.lastDisposition === 'qualified_hot';
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-4 pt-4 pb-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, company, phone..."
          className="w-full px-4 py-2.5 rounded-lg bg-jv-card border border-jv-border text-white placeholder-jv-muted focus:outline-none focus:border-jv-blue text-sm"
        />
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 px-4 pb-3 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-xs whitespace-nowrap transition-colors ${
              filter === f
                ? 'bg-jv-blue text-white'
                : 'bg-jv-card border border-jv-border text-jv-muted'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Contact list */}
      <div ref={listRef} className="flex-1 overflow-y-auto scroll-container px-4 space-y-2 pb-4">
        {loading && contacts.length === 0 && (
          <p className="text-center text-jv-muted py-8">Loading contacts...</p>
        )}
        {error && (
          <p className="text-center text-jv-red py-8">{error}</p>
        )}
        {!loading && filtered.length === 0 && (
          <p className="text-center text-jv-muted py-8">No contacts found</p>
        )}

        {[...(filter === 'All' || filter === 'Callback Pending' ? [TEST_CONTACT] : []), ...filtered].map((contact) => {
          const props = contact.properties || {};
          const name = `${props.firstname || ''} ${props.lastname || ''}`.trim() || 'Unknown';
          const phone = props.phone || props.mobilephone || '';
          const badge = callBadge(contact.callHistory);

          return (
            <div
              key={contact.id}
              className={`rounded-xl overflow-hidden ${
                contact._isTest
                  ? 'bg-jv-blue/10 border-2 border-jv-blue/40'
                  : 'bg-jv-card border border-jv-border'
              }`}
            >
              <div
                className="flex items-center justify-between p-4 cursor-pointer"
                onClick={() => handleCockpit(contact)}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${dispositionDot(contact.callHistory)}`} />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{name}</p>
                    <p className="text-sm text-jv-muted truncate">
                      {props.company || 'No company'} {phone && `· ${phone}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`text-xs ${badge.cls}`}>{badge.text}</span>
                  {phone && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCall(contact);
                      }}
                      disabled={twilioStatus !== 'ready'}
                      className="w-10 h-10 flex items-center justify-center rounded-full bg-jv-green/20 text-jv-green hover:bg-jv-green/30 transition-colors disabled:opacity-30"
                    >
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
                      </svg>
                    </button>
                  )}
                  <span className="text-jv-muted text-xs">&#8250;</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
