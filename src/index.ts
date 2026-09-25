interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * JWT decoder MCP.
 *
 * Keyless, offline: decode a JSON Web Token's header and payload and surface
 * the standard claims (exp/iat/nbf as human dates, expiry status, alg, kid).
 * Pure decode — no API, no key. It does NOT verify the signature (that needs
 * the signing key); a decoded token is not a trusted token.
 */


function b64urlToJson(seg: string): unknown {
  let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function whenClaim(v: unknown): { epoch: number; iso: string } | undefined {
  if (typeof v !== 'number') return undefined;
  return { epoch: v, iso: new Date(v * 1000).toISOString() };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'decode_jwt',
    description:
      'Decode a JSON Web Token (keyless, offline): returns the header and payload JSON plus a summary of the standard claims (iss, sub, aud, exp/iat/nbf as ISO dates, and whether it is expired). NOTE: this decodes but does NOT verify the signature — a decoded token is not a verified/trusted token.',
    inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'A JWT (header.payload.signature).' } }, required: ['token'] },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'decode_jwt') throw new Error(`Unknown tool: ${name}`);
  const token = reqStr(args, 'token', '"eyJ...header.eyJ...payload.sig"').trim();
  const parts = token.split('.');
  if (parts.length < 2) return { input: token.slice(0, 40) + '…', valid_structure: false, reason: 'A JWT has at least 2 dot-separated segments (header.payload).' };
  let header: any, payload: any;
  try { header = b64urlToJson(parts[0]); } catch { return { valid_structure: false, reason: 'Header segment is not valid base64url-encoded JSON.' }; }
  try { payload = b64urlToJson(parts[1]); } catch { return { valid_structure: false, reason: 'Payload segment is not valid base64url-encoded JSON.' }; }

  const exp = whenClaim(payload?.exp), iat = whenClaim(payload?.iat), nbf = whenClaim(payload?.nbf);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    valid_structure: true,
    header,
    payload,
    claims: {
      algorithm: header?.alg,
      key_id: header?.kid,
      issuer: payload?.iss,
      subject: payload?.sub,
      audience: payload?.aud,
      issued_at: iat?.iso,
      not_before: nbf?.iso,
      expires_at: exp?.iso,
      expired: exp ? nowSec >= exp.epoch : undefined,
      not_yet_valid: nbf ? nowSec < nbf.epoch : undefined,
    },
    signature_present: parts.length === 3 && parts[2].length > 0,
    note: 'Decoded only — signature NOT verified. Do not trust claims without verifying the signature against the issuer key.',
  };
}

function reqStr(args: Record<string, unknown>, key: string, ex: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${ex}.`);
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
