import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../config/redis';
import type { Request, Response, NextFunction } from 'express';

/** Shape of the JSON body sent on every 429 response. */
interface RateLimitErrorBody {
  success: false;
  message: string;
  code?:   string;
}

const json = (message: string, code?: string): RateLimitErrorBody => {
  const body: RateLimitErrorBody = { success: false, message };
  if (code) body.code = code;
  return body;
};

interface LimiterConfig {
  prefix:   string;
  max:      number;
  message:  string;
  windowMs: number;
  code?:    string;
}

const pendingConfigs: LimiterConfig[] = [];
const redisLimiters = new Map<string, RateLimitRequestHandler>();

export function initRedisLimiters(): void {
  for (const cfg of pendingConfigs) {
    const limiter = rateLimit({
      windowMs:        cfg.windowMs,
      max:             cfg.max,
      standardHeaders: true,   // emits RateLimit-* and Retry-After headers (draft-7)
      legacyHeaders:   false,
      message:         json(cfg.message, cfg.code),
      store: new RedisStore({
        prefix:      cfg.prefix,
        sendCommand: (...args: string[]) => redis.sendCommand(args),
      }),
    });
    redisLimiters.set(cfg.prefix, limiter);
  }
  console.log('[rateLimiter] ✅ Redis-backed limiters initialized');
}

function makeLimiter(
  prefix:   string,
  max:      number,
  message:  string,
  windowMs = 60_000,
  code?:    string,
): (req: Request, res: Response, next: NextFunction) => void {
  pendingConfigs.push({ prefix, max, message, windowMs, code });

  const memLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         json(message, code),
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const redisLimiter = redisLimiters.get(prefix);
    if (redis.isOpen && redisLimiter) {
      return redisLimiter(req, res, next);
    }
    console.warn(`[rateLimiter] Redis unavailable — memory fallback active for ${prefix}`);
    return memLimiter(req, res, next);
  };
}

export const registrationLimiter    = makeLimiter('rl:reg:',          10,  'Too many registration attempts, please try again later', 15 * 60_000);
export const loginLimiter           = makeLimiter('rl:login:',         20,  'Too many login attempts, please try again later', 15 * 60_000);
export const otpLimiter             = makeLimiter('rl:otp:',           10,  'Too many OTP attempts, please try again later', 10 * 60_000);
export const votingLimiter          = makeLimiter('rl:vote:',          30,  'Too many voting requests, please try again later');
export const refreshLimiter         = makeLimiter('rl:refresh:',       60,  'Too many token refresh attempts', 15 * 60_000);
export const generalLimiter         = makeLimiter('rl:general:',       200, 'Too many requests, please slow down');
export const receiptLimiter         = makeLimiter('rl:receipt:',       30,  'Too many receipt verification attempts, please try again later');
export const codeLookupLimiter      = makeLimiter('rl:code:',          10,  'Too many election code lookups, please try again later');
export const uploadLimiter          = makeLimiter('rl:upload:',        5,   'Too many upload attempts, please wait before uploading again');
export const publicElectionLimiter  = makeLimiter('rl:pubElection:',   30,  'Too many requests, please slow down');
export const publicResultsLimiter   = makeLimiter('rl:pub-results:',   60,  'Too many requests, please slow down');

// ── Anonymous voting rate limiters ────────────────────────────────────────────
//
// Two independent limiters are applied in sequence on POST /anon/elections/:id/vote:
//
//   1. anonHourlyLimiter  — 100 votes per hour per IP.
//      Checked first so the hourly cap always wins and blocks before the
//      short cooldown fires.  Code: ANON_HOURLY_LIMIT
//
//   2. anonCooldownLimiter — 1 vote per 10 seconds per IP.
//      Enforces the minimum gap between successive votes.
//      Code: ANON_COOLDOWN
//
// GET /anon/elections/:id/ballot keeps its own lightweight limiter so ballot
// reads are not throttled by the vote-submission cooldown.

export const anonBallotLimiter  = makeLimiter('rl:anon-ballot:',  30, 'Too many ballot requests, please slow down', 60_000);

export const anonHourlyLimiter  = makeLimiter(
  'rl:anon-hourly:',
  100,
  'You have reached the 100-vote hourly limit. Please try again after the reset.',
  60 * 60_000,         // 1-hour window
  'ANON_HOURLY_LIMIT',
);

export const anonCooldownLimiter = makeLimiter(
  'rl:anon-cooldown:',
  1,
  'Please wait 10 seconds before voting again.',
  10_000,              // 10-second window
  'ANON_COOLDOWN',
);

/**
 * @deprecated  Use `anonHourlyLimiter` + `anonCooldownLimiter` on the vote
 *              route and `anonBallotLimiter` on the ballot route instead.
 *              Kept so any import that references the old name does not break
 *              at compile time — remove once all call-sites are updated.
 */
export const anonVotingLimiter = anonCooldownLimiter;