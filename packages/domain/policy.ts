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
export type Role = 'owner' | 'audio' | 'bridge' | 'engine';
/**
 * The request target may arrive in absolute-form, where the authority precedes the path.
 * Prefix matching the raw target would read "/owner/" out of "http://owner/bridge/events"
 * and hand the route to the wrong token, so resolve the path first.
 */
export function requestPath(target: string): string {
  const absolute=/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(target);
  const path=(absolute?absolute[1]:target.split('#')[0].split('?')[0])||'/';
  return path.startsWith('/')?path:`/${path}`;
}
const ROLE_PREFIX:readonly [string,Role][]=[['/owner/','owner'],['/audio/','audio'],['/bridge/','bridge'],['/engine/','engine']];
/** Unknown paths resolve to null so an unmatched route is never authorized as the engine. */
export function requiredRole(path: string): Role | null {
  for (const [prefix,role] of ROLE_PREFIX) if (path.startsWith(prefix)) return role;
  return path==='/mcp'||path==='/ready'?'engine':null;
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
