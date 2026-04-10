/**
 * ask-nucleus.js — AI chat assistant for the sales team.
 *
 * Server-owned conversation state. Hybrid tool-use: static knowledge in
 * the system prompt (cached), dynamic DB queries via Claude tools.
 * Streams the final text response to the client via SSE.
 */

const { pool } = require('../db');
const { COMPRESSOR_CATALOG } = require('./compressor-catalog');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY_MESSAGES = 20;
const MAX_CONVERSATION_MESSAGES = 100;
const STREAM_TIMEOUT = 60000;
const NON_STREAM_TIMEOUT = 30000;

// ── Static knowledge (loaded once at require time) ──────────────

const PRODUCT_CATALOG = `Joruva Industrial products (confirmed pricing):
Compressors: JRS-7.5E 7.5HP 28CFM $7,495 | JRS-10E 10HP 38CFM $9,495 | JRS-30 30HP 125CFM $19,500 (direct)
Dryers (refrigerated): JRD-30 $2,195 | JRD-40 $2,495 | JRD-60 $2,895 | JRD-80 $3,195 | JRD-100 $3,595
Dryers (desiccant, -60°F, molecular sieve, wall-mount): JDD-40 40CFM $7,495 | JDD-80 80CFM $11,895
Filters: JPF-70 particulate 1µm $399 | JPF-130 $499 | JCF-70 coalescing 0.01µm $349 | JCF-130 $449
OWS (oil-water separator): OWS75 $234 | OWS150 $1,092
Larger systems (30HP+): direct sale, custom quote required.
For AS9100/aerospace: recommend desiccant dryer + coalescing filter. General mfg: refrigerated dryer.`;

// Full catalog as structured text for the get_product_specs tool
const FULL_CATALOG_TEXT = COMPRESSOR_CATALOG.map(c =>
  `${c.model}: ${c.hp}HP, ${c.cfm}CFM @ ${c.psi}PSI, ${c.voltage}` +
  (c.price ? `, $${c.price.toLocaleString()}` : ', quote required') +
  ` (${c.salesChannel})`
).join('\n');

// Study guide — strip HTML to plain text at load time
let STUDY_GUIDE_TEXT = '';
try {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'public', 'study-guide.html'), 'utf8');
  STUDY_GUIDE_TEXT = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 8000); // Cap to keep prompt budget reasonable
} catch {
  console.warn('Study guide not found — Ask Nucleus will operate without it');
}

// ── Escalation marker regex ─────────────────────────────────────

const ESCALATE_RE = /<!--ESCALATE:(.*?)-->/s;

function detectAndStripEscalation(text) {
  const match = text.match(ESCALATE_RE);
  if (!match) return { text, escalation: null };
  try {
    const escalation = JSON.parse(match[1]);
    return { text: text.replace(ESCALATE_RE, '').trim(), escalation };
  } catch {
    console.warn('Malformed escalation marker:', match[1].substring(0, 100));
    return { text: text.replace(ESCALATE_RE, '').trim(), escalation: null };
  }
}

// ── System prompt ───────────────────────────────────────────────

function buildSystemPrompt(identity, role) {
  return [
    {
      type: 'text',
      text: `You are Nucleus, the AI assistant for Joruva Industrial's sales team. You help reps find call notes, look up product specs, answer questions about compressed air systems, and provide sales guidance.

You are currently assisting ${identity} (${role}).

PRODUCT CATALOG:
${PRODUCT_CATALOG}

STUDY GUIDE EXCERPT:
${STUDY_GUIDE_TEXT || '(not available)'}

RULES:
- Be concise and sales-oriented. Reps are often between calls.
- When answering product questions, cite specific models, specs, and prices from the catalog.
- When searching calls, summarize what you find — don't just dump raw data.
- For AS9100/aerospace customers: always recommend desiccant dryer + coalescing filter.
- For general manufacturing: recommend refrigerated dryer.
- If you don't know something or can't find it in your tools, say so clearly.

ESCALATION:
When you cannot confidently answer a sales question (pricing authority, custom quotes, strategic decisions, or the rep explicitly asks to reach Tom), suggest escalation in your text response naturally. Then append this marker at the very end of your message (it will be stripped before display):
<!--ESCALATE:{"question":"the specific question","context":"brief context"}-->
Do NOT auto-escalate. Only suggest it when genuinely unable to answer.`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ── Tool definitions ────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_my_calls',
    description: 'Search call records by text, company, or date range. Returns AI summaries, notes, products discussed.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search in summaries, notes, lead name, company' },
        company: { type: 'string', description: 'Filter by company name' },
        days_back: { type: 'integer', description: 'How many days back to search (default 30)', default: 30 },
        caller: { type: 'string', description: 'Filter by caller identity (admin only)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_interactions',
    description: 'Search customer interaction history across all channels (voice, email, chatbot). Returns summaries, products discussed, sentiment.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search in summaries, contact name, company' },
        company: { type: 'string', description: 'Filter by company name' },
        contact: { type: 'string', description: 'Filter by contact name' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_specs',
    description: 'Look up detailed product specifications from the compressor catalog. Search by model number, HP, CFM, or product line.',
    input_schema: {
      type: 'object',
      properties: {
        product_query: { type: 'string', description: 'Model number, HP, CFM value, or product line name to search for' },
      },
      required: ['product_query'],
    },
  },
  {
    name: 'get_company_history',
    description: 'Get all interactions with a specific company. Returns chronological history of calls, emails, and other touchpoints.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'The company name to look up' },
      },
      required: ['company_name'],
    },
  },
];

// ── Tool executors ──────────────────────────────────────────────

async function executeSearchMyCalls(input, identity, role) {
  const { query, company, days_back = 30, caller } = input;
  const callerFilter = (role === 'admin' && caller) ? caller : identity;

  const daysBack = Math.min(Math.max(parseInt(days_back, 10) || 30, 1), 365);
  const where = [
    'npc.status = \'completed\'',
    `npc.caller_identity = $1`,
    `npc.created_at > NOW() - $2::int * INTERVAL '1 day'`,
  ];
  const params = [callerFilter, daysBack];
  let idx = 3;

  if (company) {
    where.push(`LOWER(npc.lead_company) LIKE LOWER($${idx++})`);
    params.push(`%${company}%`);
  }

  // IMPORTANT: This expression must match the GIN index in server/db.js
  where.push(`to_tsvector('english',
    COALESCE(npc.ai_summary,'') || ' ' || COALESCE(npc.notes,'') || ' ' ||
    COALESCE(npc.lead_name,'') || ' ' || COALESCE(npc.lead_company,''))
    @@ plainto_tsquery('english', $${idx++})`);
  params.push(query);

  const { rows } = await pool.query(
    `SELECT npc.lead_name, npc.lead_company, npc.created_at, npc.duration_seconds,
       npc.disposition, npc.ai_summary, npc.notes, npc.products_discussed
     FROM nucleus_phone_calls npc
     WHERE ${where.join(' AND ')}
     ORDER BY npc.created_at DESC LIMIT 10`,
    params
  );

  return rows.map(r => ({
    lead: r.lead_name,
    company: r.lead_company,
    date: r.created_at,
    duration_sec: r.duration_seconds,
    disposition: r.disposition,
    summary: (r.ai_summary || r.notes || '').substring(0, 200),
    products: r.products_discussed,
  }));
}

async function executeSearchInteractions(input, identity, role) {
  const { query, company, contact } = input;

  const where = [];
  const params = [];
  let idx = 1;

  if (role !== 'admin') {
    where.push(`ci.agent_name = $${idx++}`);
    params.push(identity);
  }

  if (company) {
    where.push(`LOWER(ci.company_name) LIKE LOWER($${idx++})`);
    params.push(`%${company}%`);
  }
  if (contact) {
    where.push(`LOWER(ci.contact_name) LIKE LOWER($${idx++})`);
    params.push(`%${contact}%`);
  }

  // TODO: Add GIN index to customer_interactions when table grows past ~10K rows.
  // ILIKE sequential scan is acceptable at current scale (7-person team).
  where.push(`(LOWER(ci.summary) LIKE LOWER($${idx}) OR LOWER(ci.contact_name) LIKE LOWER($${idx}) OR LOWER(ci.company_name) LIKE LOWER($${idx++}))`);
  params.push(`%${query}%`);

  const { rows } = await pool.query(
    `SELECT ci.contact_name, ci.company_name, ci.created_at, ci.channel,
       ci.summary, ci.products_discussed, ci.sentiment, ci.disposition
     FROM customer_interactions ci
     WHERE ${where.join(' AND ')}
     ORDER BY ci.created_at DESC LIMIT 10`,
    params
  );

  return rows.map(r => ({
    contact: r.contact_name,
    company: r.company_name,
    date: r.created_at,
    channel: r.channel,
    summary: (r.summary || '').substring(0, 200),
    products: r.products_discussed,
    sentiment: r.sentiment,
    disposition: r.disposition,
  }));
}

function executeGetProductSpecs(input) {
  const q = input.product_query.toLowerCase();
  const matches = COMPRESSOR_CATALOG.filter(c => {
    const text = `${c.model} ${c.hp}hp ${c.cfm}cfm ${c.productLine}`.toLowerCase();
    return text.includes(q);
  });

  if (!matches.length) {
    // Fuzzy: try matching just the number
    const num = parseFloat(q.replace(/[^0-9.]/g, ''));
    if (!isNaN(num)) {
      const byHp = COMPRESSOR_CATALOG.filter(c => c.hp === num);
      if (byHp.length) return byHp.map(formatProduct);
      const byCfm = COMPRESSOR_CATALOG.filter(c => Math.abs(c.cfm - num) <= 5);
      if (byCfm.length) return byCfm.map(formatProduct);
    }
    return [{ error: `No products matching "${input.product_query}"` }];
  }

  return matches.slice(0, 5).map(formatProduct);
}

function formatProduct(c) {
  return {
    model: c.model,
    hp: c.hp,
    cfm: c.cfm,
    psi: c.psi,
    voltage: c.voltage,
    price: c.price ? `$${c.price.toLocaleString()}` : 'quote required',
    product_line: c.productLine,
    sales_channel: c.salesChannel,
  };
}

async function executeGetCompanyHistory(input, identity, role) {
  const where = [`LOWER(ci.company_name) = LOWER($1)`];
  const params = [input.company_name];

  if (role !== 'admin') {
    where.push(`ci.agent_name = $2`);
    params.push(identity);
  }

  const { rows } = await pool.query(
    `SELECT ci.contact_name, ci.channel, ci.created_at, ci.summary,
       ci.products_discussed, ci.disposition, ci.agent_name
     FROM customer_interactions ci
     WHERE ${where.join(' AND ')}
     ORDER BY ci.created_at DESC LIMIT 10`,
    params
  );

  return rows.map(r => ({
    contact: r.contact_name,
    channel: r.channel,
    date: r.created_at,
    agent: r.agent_name,
    summary: (r.summary || '').substring(0, 200),
    products: r.products_discussed,
    disposition: r.disposition,
  }));
}

async function executeTool(name, input, identity, role) {
  switch (name) {
    case 'search_my_calls': return executeSearchMyCalls(input, identity, role);
    case 'search_interactions': return executeSearchInteractions(input, identity, role);
    case 'get_product_specs': return executeGetProductSpecs(input);
    case 'get_company_history': return executeGetCompanyHistory(input, identity, role);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ── Conversation management ─────────────────────────────────────

async function getOrCreateConversation(conversationId, identity) {
  if (conversationId) {
    const { rows } = await pool.query(
      'SELECT id, caller_identity, messages FROM ask_nucleus_conversations WHERE id = $1 AND caller_identity = $2',
      [conversationId, identity]
    );
    if (rows.length) {
      const msgs = rows[0].messages || [];
      // Auto-rotate if at capacity
      if (msgs.length >= MAX_CONVERSATION_MESSAGES) {
        return createConversation(identity);
      }
      return { id: rows[0].id, messages: msgs };
    }
  }
  return createConversation(identity);
}

async function createConversation(identity) {
  const { rows } = await pool.query(
    'INSERT INTO ask_nucleus_conversations (caller_identity) VALUES ($1) RETURNING id',
    [identity]
  );
  return { id: rows[0].id, messages: [] };
}

async function appendMessage(conversationId, message) {
  await pool.query(
    `UPDATE ask_nucleus_conversations
     SET messages = messages || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify([message]), conversationId]
  );
}

// ── Streaming orchestration ─────────────────────────────────────

/**
 * Run the Ask Nucleus chat loop.
 * @param {object} opts
 * @param {string} opts.message - User's message
 * @param {number|null} opts.conversationId - Existing conversation ID or null
 * @param {string} opts.identity - Caller identity
 * @param {string} opts.role - Caller role
 * @param {function} opts.onTextDelta - Called with each text chunk
 * @param {function} opts.onToolStatus - Called when a tool starts executing
 * @param {object} opts.signal - AbortSignal for cancellation
 * @returns {{ conversationId, escalation }}
 */
async function runChat({ message, conversationId, identity, role, onTextDelta, onToolStatus, signal }) {
  const log = (...args) => console.log('[ask-nucleus]', ...args);
  log('runChat start', { identity, role, conversationId, msgLen: message?.length });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Get or create conversation, append user message
  log('getOrCreateConversation...');
  const conv = await getOrCreateConversation(conversationId, identity);
  log('conv', { id: conv.id, msgCount: conv.messages?.length });

  const userMsg = { role: 'user', content: message, timestamp: new Date().toISOString() };
  await appendMessage(conv.id, userMsg);
  log('user message appended');

  // Build messages for Anthropic (last N from conversation)
  const allMessages = [...conv.messages, userMsg];
  const historySlice = allMessages.slice(-MAX_HISTORY_MESSAGES);

  // Convert to Anthropic format (strip timestamp, tool_uses, etc.)
  const apiMessages = historySlice.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const systemPrompt = buildSystemPrompt(identity, role);
  let fullAssistantText = '';
  let currentMessages = apiMessages;
  let toolRound = 0;
  let lastStopReason = null;

  // Tail buffer: holds back the last N streamed chars so the escalation marker
  // (<!--ESCALATE:{...}-->) never reaches the client. Longer than any marker.
  const TAIL_HOLD = 80;
  let tailBuffer = '';
  const bufferedOnTextDelta = (delta) => {
    tailBuffer += delta;
    if (tailBuffer.length > TAIL_HOLD) {
      const emit = tailBuffer.slice(0, tailBuffer.length - TAIL_HOLD);
      tailBuffer = tailBuffer.slice(-TAIL_HOLD);
      if (emit) onTextDelta(emit);
    }
  };
  // Flush the tail with the escalation marker stripped (called at stream end only)
  const flushTail = () => {
    const { text: cleanTail } = detectAndStripEscalation(tailBuffer);
    if (cleanTail) onTextDelta(cleanTail);
    tailBuffer = '';
  };

  // Attach parent signal abort handler ONCE (not per round — prevents leak)
  let currentRoundController = null;
  const onParentAbort = () => currentRoundController?.abort();
  if (signal) {
    signal.addEventListener('abort', onParentAbort);
  }

  async function callAnthropic(stream, disableTools = false) {
    log('callAnthropic start', { stream, disableTools, msgCount: currentMessages.length });
    currentRoundController = new AbortController();
    const timer = setTimeout(
      () => currentRoundController.abort(),
      stream ? STREAM_TIMEOUT : NON_STREAM_TIMEOUT
    );
    const body = {
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: currentMessages,
      stream,
      ...(disableTools ? {} : { tools: TOOLS }),
    };
    try {
      const fetchStart = Date.now();
      const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        signal: currentRoundController.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      log('callAnthropic fetch returned', { status: resp.status, ms: Date.now() - fetchStart });
      if (!resp.ok) {
        const errBody = await resp.text();
        log('callAnthropic non-ok body', errBody.substring(0, 300));
        throw new Error(`Claude API ${resp.status}: ${errBody.substring(0, 200)}`);
      }
      return resp;
    } catch (err) {
      log('callAnthropic error', err.name, err.message);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runToolResults(toolBlocks) {
    const toolResults = [];
    for (const toolUse of toolBlocks) {
      onToolStatus(toolUse.name);
      try {
        const toolResult = await executeTool(toolUse.name, toolUse.input, identity, role);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: err.message }),
          is_error: true,
        });
      }
    }
    return toolResults;
  }

  try {
    // DIAGNOSTIC: streaming mode is hanging in production. Force non-streaming
    // for all turns until we identify the root cause. The client still sees
    // responses — just buffered as one chunk at the end instead of token-by-token.
    const FORCE_NON_STREAMING = true;

    // Tool-use loop: stream first turn, non-streaming for tool continuations
    while (toolRound <= MAX_TOOL_ROUNDS) {
      if (signal?.aborted) throw new Error('aborted');

      const stream = FORCE_NON_STREAMING ? false : (toolRound === 0);
      const resp = await callAnthropic(stream);

      if (stream) {
        const result = await parseStreamResponse(resp, bufferedOnTextDelta, signal);
        lastStopReason = result.stopReason;
        fullAssistantText += result.text;

        if (result.stopReason === 'tool_use') {
          const toolResults = await runToolResults(result.toolUses);
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: result.contentBlocks },
            { role: 'user', content: toolResults },
          ];
          toolRound++;
          continue;
        }
        break; // end_turn
      } else {
        const data = await resp.json();
        lastStopReason = data.stop_reason;
        const textBlock = data.content?.find(b => b.type === 'text');
        const toolBlocks = data.content?.filter(b => b.type === 'tool_use') || [];

        if (data.stop_reason === 'tool_use' && toolBlocks.length) {
          if (textBlock) {
            fullAssistantText += textBlock.text;
            bufferedOnTextDelta(textBlock.text);
          }
          const toolResults = await runToolResults(toolBlocks);
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: data.content },
            { role: 'user', content: toolResults },
          ];
          toolRound++;
          continue;
        }

        // Non-streaming terminal response (rare — shouldn't happen mid-loop)
        if (textBlock) {
          fullAssistantText += textBlock.text;
          bufferedOnTextDelta(textBlock.text);
        }
        break;
      }
    }

    // Safety net: if we exited the loop still in tool_use state, the model
    // wanted to call more tools but hit MAX_TOOL_ROUNDS. Make one final
    // tools-disabled streaming call so the user gets a text answer.
    if (lastStopReason === 'tool_use') {
      const resp = await callAnthropic(true, true);
      const result = await parseStreamResponse(resp, bufferedOnTextDelta, signal);
      fullAssistantText += result.text;
    }

    // Flush the tail buffer (with marker stripped) to the client
    flushTail();
  } finally {
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }

  // Detect and strip escalation marker from the saved text
  const { text: cleanText, escalation } = detectAndStripEscalation(fullAssistantText);

  // Save assistant response to conversation.
  // Persist the escalation object (not just a boolean flag) so the "Send to Tom"
  // button survives page reload.
  const assistantMsg = {
    role: 'assistant',
    content: cleanText,
    timestamp: new Date().toISOString(),
    ...(escalation && { escalation }),
  };
  await appendMessage(conv.id, assistantMsg);

  return { conversationId: conv.id, escalation };
}

// ── SSE stream parser ───────────────────────────────────────────

async function parseStreamResponse(resp, onTextDelta, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const contentBlocks = [];
  const toolUses = [];
  let currentToolUse = null;
  let toolInputJson = '';
  let stopReason = null;

  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        let event;
        try { event = JSON.parse(data); } catch { continue; }

        switch (event.type) {
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: {} };
              toolInputJson = '';
            } else if (event.content_block?.type === 'text') {
              contentBlocks.push({ type: 'text', text: '' });
            }
            break;

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
              text += event.delta.text;
              if (contentBlocks.length) {
                contentBlocks[contentBlocks.length - 1].text += event.delta.text;
              }
              onTextDelta(event.delta.text);
            } else if (event.delta?.type === 'input_json_delta') {
              toolInputJson += event.delta.partial_json;
            }
            break;

          case 'content_block_stop':
            if (currentToolUse) {
              try { currentToolUse.input = JSON.parse(toolInputJson); } catch { currentToolUse.input = {}; }
              toolUses.push(currentToolUse);
              contentBlocks.push({ type: 'tool_use', id: currentToolUse.id, name: currentToolUse.name, input: currentToolUse.input });
              currentToolUse = null;
              toolInputJson = '';
            }
            break;

          case 'message_delta':
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, contentBlocks, toolUses, stopReason };
}

module.exports = { runChat, detectAndStripEscalation, getOrCreateConversation, appendMessage, TOOLS };
