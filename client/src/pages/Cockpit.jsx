import { useParams, useNavigate } from 'react-router-dom';
import useCockpit from '../hooks/useCockpit';
import RapportCard from '../components/cockpit/RapportCard';
import IntelPanel from '../components/cockpit/IntelPanel';
import TimelinePanel from '../components/cockpit/TimelinePanel';
import CompanyPanel from '../components/cockpit/CompanyPanel';
import ProductPanel from '../components/cockpit/ProductPanel';

function Skeleton() {
  return (
    <div className="space-y-4 p-4 animate-pulse">
      <div className="h-32 bg-jv-card rounded-xl" />
      <div className="h-24 bg-jv-card rounded-xl" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-48 bg-jv-card rounded-xl" />
        <div className="h-48 bg-jv-card rounded-xl" />
      </div>
      <div className="h-20 bg-jv-card rounded-xl" />
    </div>
  );
}

export default function Cockpit({ identity, callState, twilioStatus }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, refreshing, refresh } = useCockpit(id);

  function handleBack() {
    navigate('/');
  }

  async function handleCall() {
    if (twilioStatus !== 'ready' || !data?.identity) return;
    const contact = {
      id: data.identity.hubspotContactId || id,
      properties: {
        firstname: data.identity.name?.split(' ')[0] || '',
        lastname: data.identity.name?.split(' ').slice(1).join(' ') || '',
        phone: data.identity.phone,
        company: data.identity.company,
      },
    };
    try {
      await callState.startCall(contact, identity);
      navigate('/dialer', { state: { cockpitData: data } });
    } catch (err) {
      alert('Call failed: ' + err.message);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-4 pt-4 pb-2">
          <button onClick={handleBack} className="text-jv-muted hover:text-white">
            &#8592; Back
          </button>
          <span className="text-jv-muted text-sm">Loading...</span>
        </div>
        <Skeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-4">
        <p className="text-jv-red">{error}</p>
        <button onClick={handleBack} className="text-jv-blue hover:text-jv-blue/80">
          &#8592; Back to contacts
        </button>
      </div>
    );
  }

  const d = data || {};

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
        <button onClick={handleBack} className="text-jv-muted hover:text-white text-sm">
          &#8592; Back
        </button>
        <h1 className="text-lg font-semibold truncate flex-1">
          {d.identity?.name || 'Contact'}
        </h1>
      </div>

      {/* Panels */}
      <div className="flex-1 overflow-y-auto scroll-container px-4 space-y-4 pb-32">
        <RapportCard identity={d.identity} rapport={d.rapport} />
        <IntelPanel rapport={d.rapport} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TimelinePanel
            interactionHistory={d.interactionHistory}
            priorCalls={d.priorCalls}
          />
          <CompanyPanel
            companyData={d.companyData}
            icpScore={d.icpScore}
            pipelineData={d.pipelineData}
          />
        </div>

        <ProductPanel rapport={d.rapport} />
      </div>

      {/* Sticky bottom actions */}
      <div className="sticky bottom-0 px-4 py-3 bg-jv-bg border-t border-jv-border flex gap-3">
        <button
          onClick={handleCall}
          disabled={twilioStatus !== 'ready'}
          className="flex-1 py-3 rounded-xl bg-jv-green text-white font-semibold hover:bg-jv-green/90 transition-colors disabled:opacity-30"
        >
          Call Now
        </button>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="px-4 py-3 rounded-xl bg-jv-card border border-jv-border text-jv-muted hover:text-white transition-colors disabled:opacity-50"
        >
          {refreshing ? 'Refreshing...' : 'Refresh Intel'}
        </button>
      </div>
    </div>
  );
}
