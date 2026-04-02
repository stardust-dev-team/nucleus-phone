import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { saveDisposition } from '../lib/api';
import { formatDuration } from '../lib/format';

const DISPOSITIONS = [
  { value: 'connected', label: 'Connected', color: 'bg-jv-green/20 text-jv-green border-jv-green/30' },
  { value: 'voicemail', label: 'Voicemail', color: 'bg-jv-blue/20 text-jv-blue border-jv-blue/30' },
  { value: 'no_answer', label: 'No Answer', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
  { value: 'callback_requested', label: 'Callback', color: 'bg-jv-amber/20 text-jv-amber border-jv-amber/30' },
  { value: 'not_interested', label: 'Not Interested', color: 'bg-jv-red/20 text-jv-red border-jv-red/30' },
  { value: 'wrong_number', label: 'Wrong Number', color: 'bg-jv-red/20 text-jv-red border-jv-red/30' },
  { value: 'gatekeeper', label: 'Gatekeeper', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
];

const QUALIFICATIONS = [
  { value: 'hot', label: 'Hot', color: 'bg-jv-red/20 text-jv-red border-jv-red/30' },
  { value: 'warm', label: 'Warm', color: 'bg-jv-amber/20 text-jv-amber border-jv-amber/30' },
  { value: 'info_only', label: 'Info Only', color: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
];

const PRODUCTS = ['JRS-7.5E', 'JRS-10E', 'JRS-15E', 'JRS-20E', 'Other'];

export default function CallComplete({ callState, identity }) {
  const navigate = useNavigate();
  const { callData, elapsed, clearCallData } = callState;

  const [disposition, setDisposition] = useState('');
  const [qualification, setQualification] = useState('');
  const [products, setProducts] = useState([]);
  const [notes, setNotes] = useState(() => {
    if (!callData?.contact) return '';
    const props = callData.contact.properties || {};
    const name = `${props.firstname || ''} ${props.lastname || ''}`.trim();
    return `Called ${name} at ${props.company || 'Unknown'}. Duration: ${formatDuration(elapsed)}.`;
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!callData) navigate('/');
  }, [callData, navigate]);

  if (!callData) return null;

  const props = callData.contact?.properties || {};
  const name = `${props.firstname || ''} ${props.lastname || ''}`.trim() || 'Unknown';

  function toggleProduct(p) {
    setProducts((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }

  async function handleSave() {
    if (!disposition) return;
    setSaving(true);

    try {
      await saveDisposition(callData.callId, {
        disposition,
        qualification: disposition === 'connected' ? qualification : null,
        notes,
        products_discussed: disposition === 'connected' ? products : [],
      });

      clearCallData();
      navigate('/');
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto scroll-container p-4 space-y-5">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-lg font-semibold">{name}</h2>
        <p className="text-sm text-jv-muted">{props.company || ''}</p>
        <p className="text-sm text-jv-muted mt-1">Duration: {formatDuration(elapsed)}</p>
      </div>

      {/* Disposition */}
      <div>
        <label className="block text-sm text-jv-muted mb-2">How did it go?</label>
        <div className="grid grid-cols-2 gap-2">
          {DISPOSITIONS.map((d) => (
            <button
              key={d.value}
              onClick={() => setDisposition(d.value)}
              className={`py-2.5 px-3 rounded-lg text-sm font-medium border transition-colors ${
                disposition === d.value ? d.color : 'bg-jv-card border-jv-border text-jv-muted'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Qualification — only for connected */}
      {disposition === 'connected' && (
        <>
          <div>
            <label className="block text-sm text-jv-muted mb-2">How interested?</label>
            <div className="flex gap-2">
              {QUALIFICATIONS.map((q) => (
                <button
                  key={q.value}
                  onClick={() => setQualification(q.value)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    qualification === q.value ? q.color : 'bg-jv-card border-jv-border text-jv-muted'
                  }`}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-jv-muted mb-2">Products discussed</label>
            <div className="flex flex-wrap gap-2">
              {PRODUCTS.map((p) => (
                <button
                  key={p}
                  onClick={() => toggleProduct(p)}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    products.includes(p)
                      ? 'bg-jv-blue/20 text-jv-blue border-jv-blue/30'
                      : 'bg-jv-card border-jv-border text-jv-muted'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Notes */}
      <div>
        <label className="block text-sm text-jv-muted mb-2">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full px-4 py-3 rounded-lg bg-jv-card border border-jv-border text-white placeholder-jv-muted focus:outline-none focus:border-jv-blue text-sm resize-none"
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 pb-4">
        <button
          onClick={handleSave}
          disabled={!disposition || saving}
          className="flex-1 py-3 rounded-sentinel bg-jv-amber text-black font-semibold disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving...' : 'Save & Done'}
        </button>
      </div>
    </div>
  );
}
