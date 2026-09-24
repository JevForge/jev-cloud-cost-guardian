import { readFileSync, statSync } from 'node:fs';
import YAML from 'yaml';

const MAX_BYTES = 2_000_000;

export function readBounded(filePath: string, maxBytes = MAX_BYTES): string {
  const size = statSync(filePath).size;
  if (size > maxBytes) {
    throw new Error(`Refusing to read ${filePath} (${size} bytes exceeds ${maxBytes}). Split the input instead of truncating costs.`);
  }
  return readFileSync(filePath, 'utf8');
}

export function parseYamlOrJson(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} is empty`);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as unknown;
  }
  return YAML.parse(trimmed) as unknown;
}

export function uniq<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}
