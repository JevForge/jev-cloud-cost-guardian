import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CostLine } from '../schemas/cost.js';

const SECRET_PATTERNS: RegExp[] = [
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAI_GATEWAY_API_KEY\s*[:=]\s*\S+/gi,
  /\bTYPESAFE_API_KEY\s*[:=]\s*\S+/gi,
  /\bAZURE_CLIENT_SECRET\s*[:=]\s*\S+/gi,
  /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 500);
}

export function sanitizeLabel(value: string, max = 128): string {
  const cleaned = redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, max) || 'unknown';
}

export function resolveInside(workspace: string, inputPath: string): string {
  if (!inputPath.trim()) throw new Error('Path is empty');
  const root = resolve(workspace);
  const full = resolve(root, inputPath);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return full;
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function redactLine(line: CostLine): CostLine {
  const hash = shortHash(`${line.source}:${line.address}`);
  return {
    ...line,
    id: `redacted:${hash}`,
    address: `redacted:${hash}`,
    service: sanitizeLabel(line.service),
    resource_type: sanitizeLabel(line.resource_type),
    components: line.components.map(component => ({
      ...component,
      name: sanitizeLabel(component.name, 80),
    })),
  };
}

export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
