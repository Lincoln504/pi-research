/**
 * fetch_url — heuristic risk flags on the (cleaned) page text.
 *
 * HINTS, NEVER VERDICTS. Each pattern also matches pages that merely *discuss*
 * prompt injection (security write-ups, AI documentation, payload collections),
 * so a flag never blocks anything: it is surfaced to the agent next to the
 * UNTRUSTED framing, and (phase 2) handed to the safety checker as evidence.
 * Conversely, rewording, other languages or encodings slip past all of them.
 *
 * pi-search's original list (ignore-previous-instructions, system prompt, reveal,
 * exfiltrate, developer message, tool call) is folded in, narrowed where it fired
 * on ordinary documentation ("system prompt" alone is on every AI docs page).
 */

export interface RiskFlag {
  id: RiskFlagId;
  label: string;
  /** Match offsets in the scanned text (capped). */
  offsets: number[];
}

export type RiskFlagId =
  | 'instruction-override'
  | 'addressed-to-ai'
  | 'role-markup'
  | 'tool-call-markup'
  | 'prompt-leak-request'
  | 'secret-request'
  | 'exfil-link'
  | 'decode-and-run'
  | 'encoded-blob'
  | 'obfuscated-letters'
  | 'entity-encoded-text';

interface Rule {
  id: RiskFlagId;
  label: string;
  patterns: RegExp[];
  /** Skip matches inside fenced code blocks (for signals that are routine in code). */
  outsideCodeOnly?: boolean;
}

const RULES: Rule[] = [
  {
    id: 'instruction-override',
    label: 'instruction-override phrasing',
    patterns: [
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the|these|those)\b[^.\n]{0,25}?\b(?:instructions?|prompts?|rules|directions|directives|guidelines|context)\b/gi,
      /\bnew (?:instructions|directives|rules)\b\s*[:!]/gi,
      /\b(?:do not|don't|never) (?:tell|inform|alert|notify|mention (?:this|it) to) the user\b/gi,
      /\bwithout (?:asking|telling|notifying) the user\b/gi,
      /\byou (?:do not|don't) (?:have|need) to ask (?:for )?permission\b/gi,
    ],
  },
  {
    id: 'addressed-to-ai',
    label: 'text addressed to an AI reader',
    patterns: [
      /\bif you are an? (?:ai|llm|large language model|language model|assistant|agent|chatbot|bot)\b/gi,
      /\bnote (?:to|for) (?:the |any )?(?:ai|llm|assistant|agent|model|chatbot)s?\b/gi,
      /\b(?:ai|llm|coding) (?:assistants?|agents?|models?) (?:reading|processing|summari[sz]ing|browsing|visiting) (?:this|these)\b/gi,
      /\b(?:dear|attention|hey|hello)[,:]?\s+(?:ai|assistant|agent|llm|chatgpt|claude|gemini|copilot|model)\b/gi,
      /\byou are now (?:in )?(?:developer mode|dan\b|an? unrestricted)/gi,
    ],
  },
  {
    id: 'role-markup',
    label: 'chat-template / role markup',
    patterns: [
      /<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id)\|>/gi,
      /<<\/?SYS>>/g,
      /\[\/?INST\]/g,
      /"role"\s*:\s*"(?:system|developer)"/gi,
      /^\s{0,3}#{1,3}\s*(?:system|developer)(?:\s+(?:prompt|message))?\s*:?\s*$/gim,
      // (Deliberately no bare `System:` line rule: "System: Ubuntu 22.04" is routine
      // in bug reports and changelogs.)
    ],
  },
  {
    id: 'tool-call-markup',
    label: 'tool-call look-alike',
    patterns: [
      /<\/?(?:function_calls|function_results|invoke|tool_call|tool_use|tool_result|parameter name=)\b/gi,
      /"(?:tool_calls|function_call)"\s*:/gi,
    ],
  },
  {
    id: 'prompt-leak-request',
    label: 'request to reveal the prompt',
    patterns: [
      /\b(?:reveal|print|show|repeat|output|display|leak)\b[^.\n]{0,30}?\b(?:system prompt|your (?:instructions|prompt|rules)|initial prompt|hidden prompt)\b/gi,
    ],
  },
  {
    id: 'secret-request',
    label: 'request for secrets or local data',
    patterns: [
      /\b(?:send|post|upload|share|include|append|attach|exfiltrate|leak|forward|paste)\b[^.\n]{0,60}?\b(?:api[_ -]?keys?|access tokens?|tokens|passwords?|credentials?|secrets?|env(?:ironment)? variables|\.env\b|ssh keys?|id_rsa|id_ed25519|cookies?|private keys?)\b/gi,
      /\b(?:cat|read|open|print)\s+~?\/?[\w./-]*(?:\.ssh\/|\.aws\/credentials|\.env\b|id_rsa|id_ed25519|\.netrc|\.npmrc|\.git-credentials)/gi,
    ],
  },
  {
    id: 'exfil-link',
    label: 'exfiltration-shaped link',
    patterns: [
      // Markdown image whose URL carries a long query — renders (and requests) silently.
      /!\[[^\]]*\]\(https?:\/\/[^)\s]*\?[^)\s]{32,}\)/gi,
      // "append/encode ... to https://host/...=" — data-to-URL instructions.
      /\b(?:append|add|attach|encode|concatenate)\b[^.\n]{0,80}?https?:\/\/\S+[=/]\s*(?:$|[\s.,)])/gim,
    ],
  },
  {
    id: 'decode-and-run',
    label: 'decode-then-execute instruction',
    patterns: [
      /\bdecode\b[^.\n]{0,40}?\b(?:and|then)\b[^.\n]{0,20}?\b(?:execute|run|follow|eval(?:uate)?|obey)\b/gi,
    ],
  },
  {
    id: 'encoded-blob',
    label: 'long encoded blob in prose',
    outsideCodeOnly: true,
    patterns: [/[A-Za-z0-9+/]{200,}={0,2}/g],
  },
  {
    id: 'obfuscated-letters',
    label: 'look-alike Unicode letters',
    patterns: [
      /[\u{1D400}-\u{1D7FF}]{4,}/gu, // Mathematical Alphanumeric Symbols (𝗲𝘃𝗮𝗹, 𝚙𝚛𝚒𝚗𝚝)
      /[\uFF21-\uFF3A\uFF41-\uFF5A]{4,}/g, // Fullwidth Latin letters
    ],
  },
  {
    id: 'entity-encoded-text',
    label: 'HTML-entity-encoded text',
    patterns: [/(?:&#x?[0-9a-f]{2,6};){4,}/gi],
  },
];

const MAX_OFFSETS_PER_FLAG = 20;

/** [start, end) ranges of fenced code blocks (``` or ~~~ fences at line start). */
export function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { start: number; fence: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const fence = m[1]!;
    if (!open) {
      open = { start: m.index, fence };
    } else if (fence[0] === open.fence[0] && fence.length >= open.fence.length && m[0].trim() === fence) {
      ranges.push([open.start, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

function inRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

export function scanText(text: string): RiskFlag[] {
  const flags: RiskFlag[] = [];
  let fences: Array<[number, number]> | null = null;
  for (const rule of RULES) {
    const offsets: number[] = [];
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text))) {
        if (m[0].length === 0) { pattern.lastIndex++; continue; }
        if (rule.outsideCodeOnly) {
          fences ??= fencedRanges(text);
          if (inRanges(m.index, fences)) continue;
        }
        offsets.push(m.index);
        if (offsets.length >= MAX_OFFSETS_PER_FLAG) break;
      }
      if (offsets.length >= MAX_OFFSETS_PER_FLAG) break;
    }
    if (offsets.length > 0) {
      flags.push({ id: rule.id, label: rule.label, offsets: [...new Set(offsets)].sort((a, b) => a - b) });
    }
  }
  return flags;
}
