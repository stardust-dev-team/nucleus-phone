import { useState } from 'react';

function buildRows(companyData, icpScore, pipelineData) {
  const rows = [];
  if (!companyData && !icpScore) return rows;

  if (companyData) {
    if (companyData.name) rows.push(['Company', companyData.name]);
    if (companyData.industry) rows.push(['Industry', companyData.industry]);
    const location = [companyData.city, companyData.state].filter(Boolean).join(', ');
    if (location) rows.push(['Location', location]);
    if (companyData.numberofemployees) rows.push(['Employees', companyData.numberofemployees]);
    if (companyData.annualrevenue) rows.push(['Revenue', companyData.annualrevenue]);
    if (companyData.company_vernacular) rows.push(['Internal note', companyData.company_vernacular]);
  }

  if (icpScore) {
    if (icpScore.fit_score) rows.push(['ICP Score', icpScore.fit_score]);
    if (icpScore.persona) rows.push(['Persona', icpScore.persona]);
    if (icpScore.fit_reason) rows.push(['Fit Reason', icpScore.fit_reason]);
  }

  if (pipelineData?.length) {
    const segments = pipelineData.map(p => `${p.segment || 'unknown'} (${p.status})`).join(', ');
    rows.push(['Pipeline', segments]);
  }

  return rows;
}

export default function CompanyIntel({ companyData, icpScore, pipelineData }) {
  const [open, setOpen] = useState(true);
  const rows = buildRows(companyData, icpScore, pipelineData);

  if (!rows.length) return null;

  return (
    <div className="mb-4">
      <div
        className="flex justify-between items-center cursor-pointer"
        style={{ marginBottom: open ? 8 : 0 }}
        onClick={() => setOpen(!open)}
      >
        <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-wider">
          Company intel
        </div>
        <span className="text-xs text-cp-text-muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div
          className="rounded-[10px] py-3.5 px-4 transition-colors duration-300 bg-cp-card border border-cp-border"
        >
          {rows.map(([label, value], i) => (
            <div
              key={label}
              className="flex justify-between py-1.5"
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--cockpit-card-border)' : 'none' }}
            >
              <span className="text-[13px] text-cp-text-muted capitalize">{label}</span>
              <span className="text-[13px] font-medium text-cp-text text-right">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
