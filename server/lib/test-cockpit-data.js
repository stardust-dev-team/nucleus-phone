/**
 * Rich mock cockpit data for the Nucleus Test Caller.
 * Populates every cockpit panel so the team can practice
 * navigating the full briefing before live calls.
 *
 * Profile: CnC shop owner, 5 machines, realistic pipeline lead.
 */

const now = new Date();
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

const TEST_COCKPIT_DATA = {
  identity: {
    resolved: true,
    hubspotContactId: 'test-call',
    hubspotCompanyId: 'test-company',
    name: 'Mike Garza',
    email: 'mike@garzaprecision.com',
    phone: '+16026419729',
    company: 'Garza Precision Machine',
    title: 'Owner / Shop Manager',
    linkedinUrl: null,
    profileImage: null,
    pbContactData: {
      summary: '18 years in precision CNC machining. Started as a machinist at Haas Automation, opened Garza Precision in 2014. Runs a 5-machine shop specializing in aerospace brackets and hydraulic manifolds. Active in local NTMA chapter.',
      durationInRole: '10 years',
      durationInCompany: '10 years',
      pastExperience: 'Machinist at Haas Automation (6 yrs), Lead Machinist at Denton Aeroparts (2 yrs)',
      connectionDegree: '2nd',
    },
    fitScore: '88',
    fitReason: '5-machine CnC shop, aerospace + hydraulic work, high air demand, current compressor likely undersized',
    persona: 'Shop Owner',
    source: 'hubspot',
  },

  rapport: {
    rapport_starters: [
      'NTMA member — ask about last chapter meeting',
      'Aerospace brackets = tight tolerances, mention clean dry air',
      '18 yrs machining — respect the craft, skip the sales pitch',
      'Started his own shop in 2014 — self-made, hates corporate fluff',
      'Hydraulic manifolds = oily environment, filtration matters',
    ],
    intel_nuggets: [
      'Running 5 CNC machines — likely needs 50-75 CFM at 125 PSI minimum. Current 25HP recip is probably short-cycling.',
      'Aerospace work means they follow AS9100 or similar QMS. Clean dry air is a compliance requirement, not a nice-to-have.',
      'Opened email about VSD rotary screw compressors 3 times — strong interest signal. Did NOT open the reciprocating compressor email.',
      'Shop is in Arlington TX — we have a Quincy distributor (Metroplex Air Systems) 20 minutes away for install + service.',
      'His Yelp reviews mention "tight deadlines" repeatedly. Downtime from compressor issues would hit hard.',
    ],
    opening_line: 'Hey Mike, I noticed you run some aerospace bracket work — I had a question about how you handle air quality for those tight tolerance jobs.',
    adapted_script: 'Start with air quality angle (aerospace = clean dry air requirement). DO NOT lead with price or energy savings — shop owners running aerospace work care about quality and uptime first. Mention the Metroplex Air Systems service center being 20 min away — local service matters to small shops. If he mentions his current compressor, ask about short-cycling and moisture issues. The VSD rotary screw is the natural recommendation for 5 machines with variable demand. Avoid: "I saw you opened our email" — sounds creepy. Instead: "A lot of shops your size are making the switch from recips to rotary screw."',
    watch_outs: [
      'Do NOT mention his Yelp reviews or "tight deadlines" — feels like surveillance',
      'Aerospace QMS compliance is sensitive — ask, don\'t assume which standard they follow',
      'He started his own shop after working for others — respect independence, don\'t be pushy',
    ],
    product_reference: [
      'QGD 25-50 HP VSD Rotary Screw',
      'QMD Cycling Refrigerated Dryer',
      'QPC Particulate + Coalescing Filters',
      'Air Treatment Package (aerospace spec)',
    ],
    fallback: false,
  },

  interactionHistory: {
    interactions: [
      {
        channel: 'email',
        summary: 'Opened VSD rotary screw compressor email 3x — strong interest',
        disposition: null,
        createdAt: daysAgo(3),
      },
      {
        channel: 'email',
        summary: 'Clicked link to compressor sizing calculator',
        disposition: null,
        createdAt: daysAgo(5),
      },
      {
        channel: 'voice',
        summary: 'Tom — connected, discussed current compressor setup. Running 25HP recip, having moisture issues. Callback requested.',
        disposition: 'callback_requested',
        createdAt: daysAgo(8),
      },
      {
        channel: 'email',
        summary: 'Delivered: Introduction email — CnC shop air quality series',
        disposition: null,
        createdAt: daysAgo(14),
      },
    ],
  },

  priorCalls: [
    {
      id: 9001,
      created_at: daysAgo(8),
      caller_identity: 'tom',
      disposition: 'callback_requested',
      qualification: 'warm',
      notes: 'Good conversation. Running a 25HP Ingersoll Rand recip from 2016. Getting moisture in the lines, especially in summer. Knows he needs to upgrade but worried about downtime during install. Wants to talk again after he checks his lease on the current unit. Very knowledgeable — been machining 18 years.',
      duration_seconds: 342,
      products_discussed: ['QGD Rotary Screw', 'Air Dryer', 'Filtration Package'],
    },
    {
      id: 9000,
      created_at: daysAgo(21),
      caller_identity: 'kate',
      disposition: 'connected',
      qualification: null,
      notes: 'Brief intro call. Mike was on the shop floor, said to call back. Confirmed he owns the shop and handles equipment decisions.',
      duration_seconds: 87,
      products_discussed: [],
    },
  ],

  pipelineData: [
    {
      domain: 'garzaprecision.com',
      company_name: 'Garza Precision Machine',
      segment: 'cnc_machining',
      status: 'enriched',
      discovery_source: 'phantombuster_salesnav',
      created_at: daysAgo(30),
      enriched_at: daysAgo(28),
    },
  ],

  icpScore: {
    domain: 'garzaprecision.com',
    fit_score: '88',
    fit_reason: '5-machine CnC shop, aerospace + hydraulic verticals, high air demand, DFW metro (service coverage), owner-operator decision maker',
    persona: 'Shop Owner',
    segment: 'cnc_machining',
  },

  qaIntel: {
    fields_available: {
      phone: true,
      email: true,
      company: true,
      title: true,
      linkedin: false,
    },
    validation_status: 'valid',
    validated_at: daysAgo(25),
  },

  emailEngagement: [
    { event_type: 'open', created_at: daysAgo(3), campaign_name: 'CnC Air Quality Series' },
    { event_type: 'open', created_at: daysAgo(3), campaign_name: 'CnC Air Quality Series' },
    { event_type: 'open', created_at: daysAgo(4), campaign_name: 'CnC Air Quality Series' },
    { event_type: 'click', created_at: daysAgo(5), campaign_name: 'CnC Air Quality Series' },
    { event_type: 'delivered', created_at: daysAgo(14), campaign_name: 'CnC Intro Sequence' },
    { event_type: 'open', created_at: daysAgo(13), campaign_name: 'CnC Intro Sequence' },
  ],

  companyData: {
    name: 'Garza Precision Machine',
    industry: 'Industrial Machinery & Equipment',
    city: 'Arlington',
    state: 'TX',
    numberofemployees: '12',
    company_vernacular: '5-machine CnC shop, aerospace brackets + hydraulic manifolds. Owner-operator. IR recip compressor (2016) with moisture problems.',
  },
};

module.exports = { TEST_COCKPIT_DATA };
