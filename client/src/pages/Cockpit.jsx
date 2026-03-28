import { useParams, useNavigate } from 'react-router-dom';
import useCockpit from '../hooks/useCockpit';
import useCockpitTheme from '../hooks/useCockpitTheme';
import useScoreboard from '../hooks/useScoreboard';
import CockpitHeader from '../components/cockpit/CockpitHeader';
import GamificationBar from '../components/cockpit/GamificationBar';
import ContactIdentity from '../components/cockpit/ContactIdentity';
import RapportOpener from '../components/cockpit/RapportOpener';
import RapportTags from '../components/cockpit/RapportTags';
import IntelNuggets from '../components/cockpit/IntelNuggets';
import InteractionTimeline from '../components/cockpit/InteractionTimeline';
import QualScript from '../components/cockpit/QualScript';
import CompanyIntel from '../components/cockpit/CompanyIntel';
import ProductReference from '../components/cockpit/ProductReference';
import CallControls from '../components/cockpit/CallControls';

function deriveCallPhase(twilioStatus, callData) {
  if (twilioStatus === 'connecting' || twilioStatus === 'ringing' || twilioStatus === 'connected')
    return 'active';
  // Stay in post-call until callData is cleared (covers disconnected→ready race)
  if (callData && (twilioStatus === 'disconnected' || twilioStatus === 'ready'))
    return 'post';
  return 'pre';
}

function Skeleton() {
  return (
    <div className="space-y-4 p-5 animate-pulse">
      <div className="h-14 rounded-xl bg-cp-card" />
      <div className="h-24 rounded-lg" style={{ background: 'var(--cockpit-amber-50)' }} />
      <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-6">
        <div className="h-48 rounded-xl bg-cp-card" />
        <div className="h-48 rounded-xl bg-cp-card" />
      </div>
    </div>
  );
}

export default function Cockpit({ identity, callState, twilioStatus }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, refreshing, refresh } = useCockpit(id);
  const { theme, toggle } = useCockpitTheme();
  const scoreboard = useScoreboard();

  const callPhase = deriveCallPhase(twilioStatus, callState.callData);

  function handleBack() {
    navigate('/');
  }

  async function handleCallNow() {
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
    } catch (err) {
      alert('Call failed: ' + err.message);
    }
  }

  function handleEndCall() {
    callState.endCurrentCall();
  }

  function handleSaveNext() {
    navigate('/complete');
  }

  const d = data || {};

  return (
    <div
      data-theme={theme}
      className="flex flex-col h-full transition-colors duration-300 bg-cp-bg text-cp-text"
    >
      <CockpitHeader
        callPhase={callPhase}
        timer={callState.elapsed}
        onThemeToggle={toggle}
        theme={theme}
        onBack={handleBack}
        onRefresh={refresh}
        refreshing={refreshing}
      />

      <GamificationBar
        leaderboard={scoreboard.data?.leaderboard}
        currentUser={identity}
      />

      {loading ? (
        <Skeleton />
      ) : error ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-4">
          <p style={{ color: 'var(--cockpit-red-text)' }}>{error}</p>
          <button onClick={handleBack} style={{ color: 'var(--cockpit-blue-500)' }}>
            &larr; Back to contacts
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto scroll-container">
            <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-6 px-5 py-5 max-w-[1100px] mx-auto pb-20">
              {/* Left column — Rapport */}
              <div className="min-w-0">
                <ContactIdentity identity={d.identity} />
                <RapportOpener openingLine={d.rapport?.opening_line} />
                <RapportTags tags={d.rapport?.rapport_starters} />
                <IntelNuggets
                  nuggets={d.rapport?.intel_nuggets}
                  watchOuts={d.rapport?.watch_outs}
                />
                <InteractionTimeline
                  interactionHistory={d.interactionHistory}
                  priorCalls={d.priorCalls}
                />
              </div>

              {/* Right column — Business */}
              <div>
                <QualScript adaptedScript={d.rapport?.adapted_script} />
                <CompanyIntel
                  companyData={d.companyData}
                  icpScore={d.icpScore}
                  pipelineData={d.pipelineData}
                />
                <ProductReference productReference={d.rapport?.product_reference} />
              </div>
            </div>
          </div>

          <CallControls
            callPhase={callPhase}
            timer={callState.elapsed}
            onCallNow={handleCallNow}
            onEndCall={handleEndCall}
            onSaveNext={handleSaveNext}
            disabled={twilioStatus !== 'ready'}
          />
        </>
      )}
    </div>
  );
}
