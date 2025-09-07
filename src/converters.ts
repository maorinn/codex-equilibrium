// Helper functions and converters between OpenAI Chat API and Responses API

function shortenNameIfNeeded(name: string): string {
  const limit = 64;
  if (name.length <= limit) return name;
  if (name.startsWith('mcp__')) {
    const idx = name.lastIndexOf('__');
    if (idx > 0) {
      let candidate = 'mcp__' + name.slice(idx + 2);
      if (candidate.length > limit) candidate = candidate.slice(0, limit);
      return candidate;
    }
  }
  return name.slice(0, limit);
}

function buildShortNameMap(names: string[]): Record<string, string> {
  const limit = 64;
  const used: Record<string, boolean> = {};
  const map: Record<string, string> = {};
  const baseCandidate = (n: string) => {
    if (n.length <= limit) return n;
    if (n.startsWith('mcp__')) {
      const idx = n.lastIndexOf('__');
      if (idx > 0) {
        let cand = 'mcp__' + n.slice(idx + 2);
        if (cand.length > limit) cand = cand.slice(0, limit);
        return cand;
      }
    }
    return n.slice(0, limit);
  };
  const makeUnique = (cand: string) => {
    if (!used[cand]) return cand;
    const base = cand;
    for (let i = 1; ; i++) {
      const suffix = '~' + i;
      const allowed = Math.max(0, limit - suffix.length);
      let tmp = base;
      if (tmp.length > allowed) tmp = tmp.slice(0, allowed);
      tmp = tmp + suffix;
      if (!used[tmp]) return tmp;
    }
  };
  for (const n of names) {
    const cand = baseCandidate(n);
    const uniq = makeUnique(cand);
    used[uniq] = true;
    map[n] = uniq;
  }
  return map;
}

export function convertChatCompletionsToResponses(payload: any) {
  const out: any = {};
  const stream = !!payload?.stream;
  out.stream = stream;

  // Model + reasoning
  let model = payload?.model ?? 'gpt-5';
  let reasoningEffort = payload?.reasoning_effort ?? 'low';
  if (
    model === 'gpt-5-minimal' ||
    model === 'gpt-5-low' ||
    model === 'gpt-5-medium' ||
    model === 'gpt-5-high'
  ) {
    const mapEffort: Record<string, string> = {
      'gpt-5-minimal': 'minimal',
      'gpt-5-low': 'low',
      'gpt-5-medium': 'medium',
      'gpt-5-high': 'high',
    };
    reasoningEffort = mapEffort[model] || reasoningEffort;
    model = 'gpt-5';
  }
  out.model = model;
  out.reasoning = { effort: reasoningEffort };
  out.parallel_tool_calls = true;
  out.reasoning = { ...(out.reasoning || {}), summary: 'auto' };
  out.include = ['reasoning.encrypted_content'];

  // response_format -> text.format
  const rf = payload?.response_format;
  const text = payload?.text;
  if (rf && typeof rf === 'object') {
    out.text = out.text || {};
    const rft = rf.type;
    if (rft === 'text') {
      out.text.format = { type: 'text' };
    } else if (rft === 'json_schema') {
      const js = rf.json_schema || {};
      out.text.format = {
        type: 'json_schema',
        name: js.name,
        strict: js.strict,
        schema: js.schema,
      };
    }
    if (text && typeof text === 'object' && text.verbosity !== undefined) {
      out.text.verbosity = text.verbosity;
    }
  } else if (text && typeof text === 'object' && text.verbosity !== undefined) {
    out.text = out.text || {};
    out.text.verbosity = text.verbosity;
  }

  // Tools mapping (flatten function fields)
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  let originalToolNameMap: Record<string, string> = {};
  if (tools.length > 0) {
    const names: string[] = [];
    for (const t of tools) {
      if (t?.type === 'function' && t.function?.name)
        names.push(t.function.name);
    }
    if (names.length > 0) originalToolNameMap = buildShortNameMap(names);
    out.tools = [];
    for (const t of tools) {
      if (t?.type === 'function') {
        const fn = t.function || {};
        let name = fn.name || '';
        if (originalToolNameMap[name]) name = originalToolNameMap[name];
        else name = shortenNameIfNeeded(name);
        const item: any = { type: 'function', name };
        if (fn.description !== undefined) item.description = fn.description;
        if (fn.parameters !== undefined) item.parameters = fn.parameters;
        if (fn.strict !== undefined) item.strict = fn.strict;
        out.tools.push(item);
      }
    }
  }

  // Instructions from system message (string or text content)
  let instructions = 'You are a helpful assistant.';
  const msgs: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of msgs) {
    if (m?.role === 'system') {
      const c = m?.content;
      if (typeof c === 'string' && c) {
        instructions = c;
        break;
      }
      if (Array.isArray(c)) {
        const t = c.find((x: any) => x?.type === 'text' && x?.text);
        if (t?.text) {
          instructions = t.text;
          break;
        }
      }
    }
  }

  // Convert messages
  const converted: any[] = [];
  for (const m of msgs) {
    const role = m?.role;
    if (role === 'system') continue;
    const content = m?.content;
    if (typeof content === 'string') {
      if (role === 'user') converted.push({ role: 'user', content: content });
      else if (role === 'assistant')
        converted.push({ role: 'assistant', content: content });
    } else if (Array.isArray(content)) {
      const texts = content
        .filter((x: any) => x?.type === 'text' && x?.text)
        .map((x: any) => x.text)
        .join('\n');
      if (texts) {
        if (role === 'user') converted.push({ role: 'user', content: texts });
        else if (role === 'assistant')
          converted.push({ role: 'assistant', content: texts });
      }
      const tools = content.filter((x: any) => x?.type === 'tool_result');
      for (const t of tools) {
        const nameShort = t?.name || '';
        const id = t?.call_id || t?.tool_call_id || '';
        const result = t?.content || t?.output || '';
        converted.push({
          role: 'tool',
          name: nameShort,
          tool_call_id: id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }
  }
  out.input_text = converted
    .filter((x) => x.role === 'user')
    .map((x) => x.content)
    .join('\n');
  out.instructions = instructions;

  return out;
}

function buildReverseMapFromOpenAI(original: any): Record<string, string> {
  const map: Record<string, string> = {};
  const tools = Array.isArray(original?.tools) ? original.tools : [];
  for (const t of tools) {
    if (t?.type === 'function' && t?.function?.name) {
      const name = t.function.name;
      const short = shortenNameIfNeeded(name);
      map[short] = name;
    }
  }
  return map;
}

export function mapResponsesLineToChat(
  evtLine: string,
  revMap: Record<string, string>,
  state: { fnIdx?: number }
): string | undefined {
  if (!evtLine.startsWith('data: ')) return undefined;
  let evt: any;
  try {
    evt = JSON.parse(evtLine.slice(6));
  } catch {
    return undefined;
  }
  const base = {
    id: evt?.response?.id || evt?.request?.id || '',
    object: 'chat.completion.chunk',
    created: (Date.now() / 1000) | 0,
    model: evt?.response?.model || 'gpt-5',
    choices: [
      {
        index: 0,
        delta: {} as any,
        finish_reason: null as any,
        native_finish_reason: null as any,
      },
    ],
  } as any;

  switch (evt?.type) {
    case 'response.reasoning_summary_text.delta': {
      base.choices[0].delta.reasoning_content = evt?.delta || '';
      return JSON.stringify(base);
    }
    case 'response.reasoning_summary_text.done': {
      base.choices[0].delta.reasoning_content = '\n\n';
      return JSON.stringify(base);
    }
    case 'response.output_text.delta': {
      base.choices[0].delta.content = evt?.delta || '';
      return JSON.stringify(base);
    }
    case 'response.output_item.done': {
      const item = evt?.item;
      if (item?.type !== 'function_call') return undefined;
      state.fnIdx = (state.fnIdx ?? -1) + 1;
      const nameShort = item?.name || '';
      const name = revMap[nameShort] || nameShort;
      base.choices[0].delta.tool_calls = [
        {
          index: state.fnIdx,
          id: item?.call_id || '',
          type: 'function',
          function: { name, arguments: item?.arguments || '' },
        },
      ];
      return JSON.stringify(base);
    }
    case 'response.completed': {
      const fr =
        state.fnIdx != null && state.fnIdx >= 0 ? 'tool_calls' : 'stop';
      base.choices[0].finish_reason = fr;
      base.choices[0].native_finish_reason = fr;
      return JSON.stringify(base);
    }
    default:
      return undefined;
  }
}

// Non-stream mapping: Responses SSE blob -> OpenAI Chat JSON
export function convertResponsesBlobToChat(
  originalOpenAI: any,
  blob: string
): string {
  const rev = buildReverseMapFromOpenAI(originalOpenAI);
  const lines = blob.split(/\r?\n/);
  let completed: any;
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    let obj;
    try {
      obj = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (obj?.type === 'response.completed') {
      completed = obj;
      break;
    }
  }
  if (!completed) return JSON.stringify({ error: 'invalid_upstream_response' });
  const resp = completed.response || {};
  const template: any = {
    id: resp.id || '',
    object: 'chat.completion',
    created: resp.created_at || (Date.now() / 1000) | 0,
    model: resp.model || 'gpt-5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as any },
        finish_reason: null,
        native_finish_reason: null,
      },
    ],
  };
  const usage = resp.usage || {};
  if (usage) {
    template.usage = {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      completion_tokens_details: {
        reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens,
      },
    };
  }
  let contentText = '';
  let reasoningText = '';
  const toolCalls: any[] = [];
  const outArr = Array.isArray(resp.output) ? resp.output : [];
  for (const it of outArr) {
    if (it?.type === 'reasoning' && Array.isArray(it?.summary)) {
      for (const sum of it.summary) {
        if (sum?.type === 'summary_text' && sum?.text) {
          reasoningText = sum.text;
          break;
        }
      }
    } else if (it?.type === 'message' && Array.isArray(it?.content)) {
      for (const part of it.content) {
        if (part?.type === 'output_text' && part?.text) {
          contentText = part.text;
          break;
        }
      }
    } else if (it?.type === 'function_call') {
      const nameShort = it?.name || '';
      const name = rev[nameShort] || nameShort;
      toolCalls.push({
        id: it?.call_id || '',
        type: 'function',
        function: { name, arguments: it?.arguments || '' },
      });
    }
  }
  if (contentText)
    (template.choices[0].message.content = contentText),
      (template.choices[0].message.role = 'assistant');
  if (reasoningText)
    (template.choices[0].message.reasoning_content = reasoningText),
      (template.choices[0].message.role = 'assistant');
  if (toolCalls.length)
    (template.choices[0].message.tool_calls = toolCalls),
      (template.choices[0].finish_reason = 'tool_calls'),
      (template.choices[0].native_finish_reason = 'tool_calls');
  else
    (template.choices[0].finish_reason = 'stop'),
      (template.choices[0].native_finish_reason = 'stop');
  return JSON.stringify(template);
}

// Convert Chat -> Completions (non-stream)
export function convertChatToCompletions(chatJSON: string): string {
  let root: any;
  try {
    root = JSON.parse(chatJSON);
  } catch {
    return chatJSON;
  }
  const out: any = {
    id: root.id,
    object: 'text_completion',
    created: root.created,
    model: root.model,
    choices: [],
  };
  const usage = root.usage;
  if (usage) out.usage = usage;
  const msg = root?.choices?.[0]?.message;
  const text = msg?.content || '';
  out.choices.push({
    index: 0,
    text,
    finish_reason: root?.choices?.[0]?.finish_reason,
    logprobs: null,
  });
  return JSON.stringify(out);
}

// Convert Chat Chunk -> Completions Chunk (stream)
export function convertChatChunkToCompletionsChunk(
  chunkJSON: string
): string | undefined {
  let root: any;
  try {
    root = JSON.parse(chunkJSON);
  } catch {
    return undefined;
  }
  const text = root?.choices?.[0]?.delta?.content;
  const finish = root?.choices?.[0]?.finish_reason ?? null;
  const out: any = {
    id: root.id,
    object: 'text_completion',
    created: root.created,
    model: root.model,
    choices: [{ index: 0, text: text ?? '', finish_reason: finish }],
  };
  if (root.usage) out.usage = root.usage;
  return JSON.stringify(out);
}

