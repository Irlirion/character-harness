import { readFileSync } from 'node:fs';
export function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = (file ? readFileSync(file, 'utf8') : process.env[name])?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
