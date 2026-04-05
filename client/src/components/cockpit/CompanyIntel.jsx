import { useState } from 'react';

function formatCurrency(amount) {
  if (!amount) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(amount);
}

function buildRows(companyData, icpScore, pipelineData, signalMetadata, pbContactData) {
  const rows = [];
  if (!companyData && !icpScore && !signalMetadata && !pbContactData) return rows;

  if (companyData) {
    if (companyData.name) rows.push(['Company', companyData.name]);
    if (companyData.industry) rows.push(['Industry', companyData.industry]);
    const location = [companyData.city, companyData.state].filter(Boolean).join(', ');
    if (location) rows.push(['Location', location]);
    if (companyData.numberofemployees) rows.push(['Employees', companyData.numberofemployees]);
    if (companyData.annualrevenue) rows.push(['Revenue', formatCurrency(companyData.annualrevenue)]);
    if (companyData.company_vernacular) rows.push(['Internal note', companyData.company_vernacular]);
  }

  // PB enrichment fills gaps when HubSpot company data is absent
  if (!companyData?.industry && pbContactData?.industry)
    rows.push(['Industry', pbContactData.industry]);
  if (!companyData?.city && pbContactData?.location)
    rows.push(['Location', pbContactData.location]);

  // Signal metadata — cert, contracts, sources
  if (signalMetadata) {
    if (signalMetadata.cert_standard) {
      let certValue = signalMetadata.cert_standard;
      if (signalMetadata.cert_body) certValue += ` (${signalMetadata.cert_body})`;
      rows.push(['Certification', certValue]);
    }
    if (signalMetadata.cert_expiry_date) {
      const expiry = new Date(signalMetadata.cert_expiry_date);
      const isExpired = expiry < Date.now();
      const expiryStr = expiry.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      rows.push(['Cert Expiry', isExpired ? `${expiryStr} — EXPIRED` : expiryStr]);
    }
    if (signalMetadata.contract_total) {
      const label = signalMetadata.dod_flag ? 'DoD Contracts' : 'Govt Contracts';
      rows.push([label, formatCurrency(signalMetadata.contract_total)]);
    } else if (signalMetadata.dod_flag) {
      rows.push(['DoD Contractor', 'Yes']);
    }
    if (signalMetadata.source_count > 1) {
      rows.push(['Signal Sources', `${signalMetadata.source_count}x match`]);
    }
  }

  // Lead reservoir enrichment — fills gaps when HubSpot company data is absent
  if (icpScore) {
    if (!companyData?.industry && !pbContactData?.industry && icpScore.industry_description)
      rows.push(['Industry', icpScore.industry_description]);
    if (icpScore.employee_range && !companyData?.numberofemployees)
      rows.push(['Employees', icpScore.employee_range]);
    if (icpScore.revenue_range && !companyData?.annualrevenue)
      rows.push(['Revenue', icpScore.revenue_range]);
    if (icpScore.geo_city && icpScore.geo_state && !companyData?.city)
      rows.push(['Location', `${icpScore.geo_city}, ${icpScore.geo_state}`]);
    if (icpScore.icp_score != null) rows.push(['ICP Score', icpScore.icp_score]);
    if (icpScore.prequalify_class) rows.push(['Pre-qualify', icpScore.prequalify_class]);
  }

  if (pipelineData?.length) {
    const segments = pipelineData.map(p => `${p.segment || 'unknown'} (${p.status})`).join(', ');
    rows.push(['Pipeline', segments]);
  }

  return rows;
}

export default function CompanyIntel({ companyData, icpScore, pipelineData, signalMetadata, pbContactData }) {
  const [open, setOpen] = useState(true);
  const rows = buildRows(companyData, icpScore, pipelineData, signalMetadata, pbContactData);

  if (!rows.length) return null;

  return (
    <div className="mb-3">
      <div
        className="flex justify-between items-center cursor-pointer"
        style={{ marginBottom: open ? 6 : 0 }}
        onClick={() => setOpen(!open)}
      >
        <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-[1.5px]">
          Company intel
        </div>
        <span className="text-xs text-cp-text-muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div
          className="rounded py-2.5 px-3.5 transition-colors duration-300 bg-cp-card border border-cp-border"
        >
          {rows.map(([label, value], i) => (
            <div
              key={label}
              className="flex justify-between py-1.5"
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--cockpit-card-border)' : 'none' }}
            >
              <span className="text-sm text-cp-text-muted capitalize">{label}</span>
              <span className="text-sm font-normal text-cp-text text-right">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
