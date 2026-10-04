const QUOTA_INFO='usageLimitExceeded';
const FALLBACK_MS=15*60_000;
const MIN_MS=60_000;
const MAX_MS=3*60*60_000;
const RESET_TIME=/\bat\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/;

export type TurnFailure='usage_limit'|'transient';
export type AttemptFailureDeps = {
  /** The event handed out by nextEvent, if this attempt had one. */
  eventId: string | undefined;
  defer: (eventId: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  now: () => number;
};
type TurnError={message?:unknown;codexErrorInfo?:unknown};
type Turn={status?:unknown;error?:unknown};

/** A quota stop is not a transient fault, so it must not be retried on the normal loop. */
export function classifyTurnFailure(turn:Turn|undefined):TurnFailure{
  const info=(turn?.error as TurnError|undefined)?.codexErrorInfo;
  return info===QUOTA_INFO?'usage_limit':'transient';
}

/**
 * Owns what happens after a turn attempt fails. The engine rejects with an error carrying the
 * turn, so the failure class survives the throw; anything else stays a one second retry.
 */
export async function handleAttemptFailure(error:unknown,deps:AttemptFailureDeps):Promise<void>{
  const turn=(error as {turn?:Turn}|undefined)?.turn;
  const failure=classifyTurnFailure(turn);
  if(failure==='usage_limit'){
    // Give the event back before pausing: nextEvent charges an attempt when it hands one out,
    // so a cooldown that keeps the claim would strand an unanswered message permanently.
    if(deps.eventId!==undefined)await deps.defer(deps.eventId).catch(()=>{});
    const retryInMs=usageLimitDelayMs(turn?.error as TurnError|undefined,deps.now());
    deps.log({event:'codex_usage_limit',retry_in_ms:retryInMs});
    await deps.sleep(retryInMs);
    return;
  }
  deps.log({event:'codex_attempt_failed',error_type:error instanceof Error?error.message:'unknown'});
  await deps.sleep(1000);
}

/**
 * The quota message states a reset time without a timezone. Read it as UTC, which is the
 * only self-consistent reading against the engine clock, then clamp: a misread costs one
 * extra attempt instead of a long stall or a tight retry loop.
 */
export function usageLimitDelayMs(error:TurnError|undefined,nowMs:number):number{
  const message=typeof error?.message==='string'?error.message:'';
  const match=RESET_TIME.exec(message);
  if(!match)return FALLBACK_MS;
  let hours=Number(match[1])%12;
  if(match[3]==='PM')hours+=12;
  const day=Math.floor(nowMs/86_400_000);
  const reset=(day*86_400_000)+hours*3_600_000+Number(match[2])*60_000;
  const delay=reset-nowMs;
  if(delay<=0)return FALLBACK_MS;
  return Math.min(MAX_MS,Math.max(MIN_MS,delay));
}
