import { timingSafeEqual } from 'node:crypto';

export type Principal = { characterId: string; audienceId: string };
export type Memory = Principal & { id: string; text: string; source: string; createdAt: string };
export class DomainError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function matchesToken(header: unknown, token: string): boolean {
  if (typeof header !== 'string' || token.length < 32) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function canReadMemory(principal: Principal, memory: Memory): boolean {
  return principal.characterId === memory.characterId && principal.audienceId === memory.audienceId;
}
export function assertActive(state: { paused: boolean; epoch: number }, epoch: number): void {
  if (state.paused) throw new DomainError('paused');
  if (state.epoch !== epoch) throw new DomainError('stale_epoch');
}
export function assertReplay(original: string, incoming: string): void {
  if (original !== incoming) throw new DomainError('invocation_conflict');
}
export function snapshot(principal: Principal, memories: Memory[]) {
  return { ...principal, memories: memories.filter(m => canReadMemory(principal, m)) };
}
