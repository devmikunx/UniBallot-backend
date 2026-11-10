import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { validate } from '../middleware/validate';
import { concurrencyLimit } from '../middleware/concurrencyLimit';
import {
  anonBallotLimiter,
  anonHourlyLimiter,
  anonCooldownLimiter,
  publicResultsLimiter,
} from '../middleware/rateLimiter';
import { authenticate } from '../middleware/authenticate';
import { voteSubmissionSchema } from '../controllers/voting.controller';
import {
  getAnonBallotHandler,
  submitAnonBallotHandler,
  resolveResultsToken,
  getAnonLiveStatsHandler,
} from '../controllers/anonVoting.controller';

const router = Router();

router.use(cookieParser());

router.get('/elections/:id/ballot', anonBallotLimiter, getAnonBallotHandler);

router.post(
  '/elections/:id/vote',
  anonHourlyLimiter,
  anonCooldownLimiter,
  concurrencyLimit,
  validate(voteSubmissionSchema),
  submitAnonBallotHandler,
);

router.get('/results/token/:token', publicResultsLimiter, resolveResultsToken);

router.get('/elections/:id/live-stats', authenticate, getAnonLiveStatsHandler);

export default router;