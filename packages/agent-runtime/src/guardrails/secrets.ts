/**
 * Credential-shape detection (§14). Matches on *shape* rather than on known
 * values, so a token that arrives from an integration response is caught too.
 *
 * Used in two directions: refusing to write a secret into the repo, and
 * redacting events before they are persisted or displayed.
 */

export interface SecretMatch {
  rule: string;
  /** Never the secret itself. */
  description: string;
  index: number;
}

interface Pattern {
  rule: string;
  description: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { rule: 'aws-access-key', description: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'private-key', description: 'PEM private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { rule: 'github-token', description: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { rule: 'slack-token', description: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: 'anthropic-key', description: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'openai-key', description: 'OpenAI-style API key', re: /\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/g },
  { rule: 'jwt', description: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { rule: 'google-key', description: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    rule: 'assigned-secret',
    description: 'a credential assigned to a variable',
    // Requires a long, secret-looking literal: `apiKey: token` is a reference,
    // `apiKey = "hunter2hunter2hunter2..."` is a leak. Placeholders are
    // excluded below so a fixture or a docs example does not block a run.
    re: /\b(?:api[_-]?key|secret|password|passwd|token|credential)\s*[:=]\s*["'`]([^"'`\n]{12,})["'`]/gi,
  },
];

/** Obvious non-secrets that would otherwise trip `assigned-secret`. */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]+>|\$\{[^}]*\}|process\.env\.|import\.meta\.|your[_-]?|placeholder|example|changeme|redacted|dummy|fake|test[_-]?|sample)/i;

export function findSecrets(text: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const { rule, description, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (rule === 'assigned-secret') {
        const value = m[1] ?? '';
        if (PLACEHOLDER.test(value) || !looksRandom(value)) continue;
      }
      out.push({ rule, description, index: m.index });
    }
  }
  return out;
}

export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

/**
 * Replace credential shapes with a marker. Runs over every event before it is
 * persisted or displayed (§14) — a redaction pass that only knows the values it
 * was told about would miss anything the run discovered.
 */
export function redact(text: string): string {
  let out = text;
  for (const { rule, re } of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), (match, captured?: string) => {
      if (rule === 'assigned-secret') {
        const value = captured ?? '';
        if (PLACEHOLDER.test(value) || !looksRandom(value)) return match;
        return match.replace(value, `«redacted:${rule}»`);
      }
      return `«redacted:${rule}»`;
    });
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}

/**
 * A real credential has mixed character classes and little structure. Prose,
 * paths and sentences do not, and flagging those would train people to ignore
 * the warning.
 */
function looksRandom(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value.includes('/') && !/[A-Z]/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z0-9]/, /[^A-Za-z]/].filter((re) => re.test(value)).length;
  return classes >= 2 && value.length >= 12;
}
