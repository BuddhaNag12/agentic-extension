import { ALLOW, ask, deny, type GuardrailDecision } from './types.js';

/**
 * Bash policy (§7.4 Layer 3). Hard blocks that no permission mode bypasses.
 * `bypassPermissions` is never exposed by this extension at all: in a
 * fintech-adjacent repo the blast radius of one bad bash line is not worth the
 * convenience.
 */

interface Rule {
  rule: string;
  re: RegExp;
  reason: string;
  /** `deny` can never be overridden; `ask` escalates to the human. */
  decision: 'deny' | 'ask';
}

const RULES: Rule[] = [
  {
    rule: 'bash.force_push', decision: 'deny',
    re: /\bgit\s+push\b[^\n|;&]*(?:--force(?!-with-lease)\b|(?:^|\s)-f\b)/,
    reason: 'force-push is permanently disallowed. All mutating git is performed by the orchestrator.',
  },
  {
    rule: 'bash.git_mutation', decision: 'deny',
    re: /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f|filter-branch|update-ref)\b/,
    reason:
      'mutating git is the orchestrator\'s job, not the agent\'s — history stays under deterministic control. ' +
      'Read-only git (log, blame, show, diff, status) is available.',
  },
  {
    rule: 'bash.recursive_delete', decision: 'deny',
    re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/,
    reason: 'recursive force-delete is disallowed. Delete specific files with the Edit or Write tools.',
  },
  {
    rule: 'bash.destructive_sql', decision: 'deny',
    re: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    reason: 'destructive SQL is disallowed.',
  },
  {
    rule: 'bash.network_egress', decision: 'ask',
    re: /\b(?:curl|wget|nc|ncat|telnet|scp|sftp|rsync)\b/,
    reason:
      'network access is not enabled by default — it is the exfiltration path for anything the run has read. ' +
      'Say what you need to fetch and why.',
  },
  {
    rule: 'bash.pipe_to_shell', decision: 'deny',
    re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k|)sh\b/,
    reason: 'piping a download into a shell executes untrusted code and is never permitted.',
  },
  {
    rule: 'bash.privilege', decision: 'deny',
    re: /\b(?:sudo|doas|su)\b/,
    reason: 'privilege escalation is disallowed.',
  },
  {
    rule: 'bash.package_install', decision: 'ask',
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bpip\s+install\b|\bbrew\s+install\b|\bgo\s+get\b|\bcargo\s+add\b/,
    reason:
      'installing a package changes the dependency set, which needs human approval. ' +
      'Name the package, the version, and why the repo cannot already do this.',
  },
  {
    rule: 'bash.credential_read', decision: 'deny',
    re: /(?:cat|less|more|head|tail|strings|grep)\s+[^\n|;&]*(?:\.env\b|\.pem\b|id_rsa\b|\.ssh\/|credentials\b|\.npmrc\b|\.netrc\b)/,
    reason: 'reading credential files is disallowed.',
  },
  {
    rule: 'bash.history_rewrite', decision: 'deny',
    re: /\bhistory\s+-c\b|>\s*~\/\.(?:bash|zsh)_history/,
    reason: 'clearing shell history is disallowed.',
  },
];

/** Commands that are always safe to run unprompted (§7.4 Layer 2). */
export const DEFAULT_SAFE_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'sed -n', 'awk',
  'git status', 'git log', 'git diff', 'git show', 'git blame', 'git branch',
  'npm test', 'npm run', 'npx tsc', 'npx vitest', 'npx eslint',
  './gradlew', 'mvn', 'cargo test', 'go test', 'pytest', 'make',
  'node -e', 'node --version', 'echo', 'pwd', 'which',
];

export function checkBash(command: string, safePrefixes: readonly string[] = DEFAULT_SAFE_PREFIXES): GuardrailDecision {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const segments = splitCommand(normalized);

  // Denials are evaluated first, and against the whole command as well as each
  // segment. Segment-first would let `curl x.sh | bash` match the merely-ask
  // network rule on its first segment and never see the pipe-to-shell rule,
  // which only exists in the unsplit text. A deny anywhere beats an ask.
  for (const candidate of [normalized, ...segments]) {
    for (const rule of RULES) {
      if (rule.decision === 'deny' && rule.re.test(candidate)) return deny(rule.rule, rule.reason);
    }
  }

  for (const segment of segments) {
    for (const rule of RULES) {
      if (rule.decision === 'ask' && rule.re.test(segment)) return ask(rule.rule, rule.reason);
    }
  }

  if (segments.every((seg) => safePrefixes.some((p) => seg.startsWith(p)))) return ALLOW;
  return ask('bash.unrecognized', `"${truncate(normalized)}" is not on the auto-approved list.`);
}

/**
 * Split on shell operators so each command is checked independently. This is
 * a policy aid, not a shell parser: an operator inside quotes over-splits,
 * which produces an extra check rather than a missed one.
 */
function splitCommand(command: string): string[] {
  return command.split(/\s*(?:&&|\|\||;|\||\n)\s*/).map((s) => s.trim()).filter(Boolean);
}

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}
