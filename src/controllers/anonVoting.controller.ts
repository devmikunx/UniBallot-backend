import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { getBallotData } from '../services/voting.service';
import { voteLimit } from '../server';
import AnonVoterToken from '../models/AnonVoterToken';
import Vote from '../models/Vote';
import Election from '../models/Election';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/apiResponse';
import { logAction } from '../services/audit.service';
import { AUDIT_ACTIONS } from '../config/constants';
import { env } from '../config/env';

export const getAnonBallotHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { election, offices, candidates } = await getBallotData(id);

  if ((election as any).electionMode !== 'anonymous') {
    throw new AppError(403, 'This endpoint is only for anonymous elections');
  }

  const statusMessages: Record<string, string> = {
    draft:               'This election has not started yet',
    setup:               'This election is not open for voting yet',
    registration_open:   'This election is not open for voting yet',
    registration_closed: 'This election is not open for voting yet',
    paused:              'Voting is temporarily paused',
    voting_closed:       'Voting has ended',
    results_published:   'Voting has ended',
  };

  if (election.status !== 'voting_open') {
    throw new AppError(400, statusMessages[election.status] ?? 'Voting is not available');
  }

  const candidatesByOffice = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!candidatesByOffice.has(c.officeId)) candidatesByOffice.set(c.officeId, []);
    candidatesByOffice.get(c.officeId)!.push(c);
  }

  const ballot = offices.map((office) => {
    const officeCandidates = candidatesByOffice.get(office._id) ?? [];
    const voteType = officeCandidates.length === 1 ? 'confirmation' : 'competitive';
    return {
      officeId:          office._id,
      officeTitle:       office.title,
      officeDescription: office.description,
      voteType,
      candidates: officeCandidates.map((c) => ({
        candidateId: c._id,
        fullName:    c.fullName,
        bio:         c.bio,
        photoUrl:    c.photoUrl,
      })),
      options: voteType === 'confirmation' ? ['approve', 'reject'] : undefined,
    };
  });

  sendSuccess(res, { offices: ballot });
});

export const submitAnonBallotHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id: electionId } = req.params;
  const { votes } = req.body as { votes: Array<{ officeId: string; candidateId?: string; confirmationChoice?: 'approve' | 'reject' }> };

  let voterToken: string = req.cookies?.['ub_anon_voter'] ?? '';
  if (!voterToken) voterToken = crypto.randomUUID();

  // NOTE: No redis pre-check here.
  // The anonCooldownLimiter (10 s, per IP) and anonHourlyLimiter (100/hr, per IP)
  // in anon.routes.ts already enforce frequency limits before we reach this handler.
  // The AnonVoterToken DB check below enforces the permanent per-election uniqueness
  // per browser identity (cookie token). A separate redis key would be redundant
  // and would incorrectly block re-votes during the cooldown window.

  const { election, offices, candidates } = await getBallotData(electionId);

  if (election.electionMode !== 'anonymous') {
    throw new AppError(403, 'This endpoint is only for anonymous elections');
  }
  if (election.status !== 'voting_open') {
    throw new AppError(400, 'Voting is not open');
  }

  // For anonymous UNLIMITED voting there is NO per-election uniqueness check on
  // the token.  The same browser (cookie token) can vote as many times as it
  // likes — rate limits (cooldown + hourly cap) are the only throttle.
  // We still write an AnonVoterToken record per vote for the audit trail, but
  // we do NOT block if one already exists.

  const officeIds    = offices.map((o) => o._id);
  const submittedIds = votes.map((v) => v.officeId);
  const missing = officeIds.filter((id) => !submittedIds.includes(id));
  const extra   = submittedIds.filter((id) => !officeIds.includes(id));
  const dupes   = submittedIds.filter((id, i) => submittedIds.indexOf(id) !== i);
  if (missing.length || extra.length || dupes.length) {
    throw new AppError(400, `Ballot mismatch. Missing: [${missing.join(', ')}] Extra: [${extra.join(', ')}] Duplicates: [${dupes.join(', ')}]`);
  }

  const candidatesByOffice = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!candidatesByOffice.has(c.officeId)) candidatesByOffice.set(c.officeId, []);
    candidatesByOffice.get(c.officeId)!.push(c);
  }
  const officeMap = new Map(offices.map((o) => [o._id, o]));

  for (const vote of votes) {
    const office = officeMap.get(vote.officeId);
    if (!office) throw new AppError(400, `Unknown officeId: ${vote.officeId}`);
    const officeCandidates = candidatesByOffice.get(office._id) ?? [];
    const voteType = officeCandidates.length === 1 ? 'confirmation' : 'competitive';
    if (voteType === 'competitive') {
      if (!vote.candidateId) throw new AppError(400, `candidateId required for office "${office.title}"`);
      if (!officeCandidates.some((c) => c._id === vote.candidateId)) throw new AppError(400, `Invalid candidateId for office "${office.title}"`);
    } else {
      if (!vote.confirmationChoice || !['approve', 'reject'].includes(vote.confirmationChoice)) {
        throw new AppError(400, `confirmationChoice must be 'approve' or 'reject' for office "${office.title}"`);
      }
    }
  }

  const submittedAt  = new Date();
  const electionOid  = new mongoose.Types.ObjectId(electionId);
  const voteDocs = votes.map((vote) => ({
    electionId:         electionOid,
    officeId:           new mongoose.Types.ObjectId(vote.officeId),
    candidateId:        vote.candidateId ? new mongoose.Types.ObjectId(vote.candidateId) : undefined,
    confirmationChoice: vote.confirmationChoice,
    ballotToken:        voterToken,
    voteHash:           crypto.createHash('sha256').update(`${electionId}${vote.officeId}${vote.candidateId ?? vote.confirmationChoice ?? ''}${submittedAt.toISOString()}${env.VOTE_HASH_SECRET ?? ''}`).digest('hex'),
    createdAt:          submittedAt,
  }));

  await voteLimit(async () => {
    try {
      await Vote.insertMany(voteDocs, { ordered: false });
    } catch (err) {
      throw err;
    }
  });

  // Upsert: update the existing record's votedAt/expiresAt for the latest vote,
  // or insert a new one.  Using updateOne+upsert avoids duplicate-key errors
  // from the unique index while still maintaining the audit trail.
  await AnonVoterToken.updateOne(
    { electionId, token: voterToken },
    { $set: { votedAt: submittedAt, expiresAt: new Date(submittedAt.getTime() + 86_400_000) } },
    { upsert: true },
  ).catch(() => null); // non-fatal — audit trail, not enforcement

  logAction({
    action:      AUDIT_ACTIONS.ANON_VOTE_SUBMITTED,
    performedBy: new mongoose.Types.ObjectId('000000000000000000000000'),
    targetId:    electionOid,
    targetModel: 'Vote',
    metadata:    { electionId, votedAt: submittedAt.toISOString() },
  }).catch(() => null);

  res.cookie('ub_anon_voter', voterToken, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   7_776_000_000,
  });

  sendSuccess(res, { message: 'You have voted successfully. Thank you.' }, 'Vote submitted', 201);
});

export const resolveResultsToken = asyncHandler(async (req: Request, res: Response) => {
  const election = await Election.findOne({
    resultsToken: req.params.token,
    resultsPublic: true,
    status: 'results_published',
  }).select('_id title results resultsToken').lean();

  if (!election) throw new AppError(404, 'Not found');
  sendSuccess(res, { electionId: election._id, title: election.title, results: election.results ?? [] });
});

export const getAnonLiveStatsHandler = asyncHandler(async (req: Request, res: Response) => {
  const electionId = req.params.id;
  const election = await Election.findById(electionId).lean();
  if (!election) throw new AppError(404, 'Election not found');

  if (election.electionMode !== 'anonymous') {
    throw new AppError(403, 'This endpoint is only for anonymous elections');
  }

  const user = req.user;
  const isOwner =
    user.role === 'public_creator' &&
    election.createdByPublic != null &&
    election.createdByPublic.toString() === user._id.toString();
  const isSuperAdmin = user.role === 'super_admin';
  if (!isOwner && !isSuperAdmin) {
    throw new AppError(403, 'You are not authorized for this election');
  }

  const [offices, candidates, perOfficeCounts, perCandidateCounts, confirmationCounts] =
    await Promise.all([
      (await import('../models/Office')).default.find({ electionId }).lean(),
      (await import('../models/Candidate')).default.find({ electionId }).lean(),
      Vote.aggregate<{ _id: string; count: number }>([
        { $match: { electionId: new mongoose.Types.ObjectId(electionId) } },
        { $group: { _id: '$officeId', count: { $sum: 1 } } },
      ]),
      Vote.aggregate<{ _id: string; count: number }>([
        {
          $match: {
            electionId: new mongoose.Types.ObjectId(electionId),
            candidateId: { $exists: true },
          },
        },
        { $group: { _id: '$candidateId', count: { $sum: 1 } } },
      ]),
      Vote.aggregate<{ _id: { officeId: string; choice: string }; count: number }>([
        {
          $match: {
            electionId: new mongoose.Types.ObjectId(electionId),
            confirmationChoice: { $exists: true },
          },
        },
        {
          $group: {
            _id: { officeId: '$officeId', choice: '$confirmationChoice' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

  const officeVoteMap = new Map(perOfficeCounts.map(r => [r._id.toString(), r.count]));
  const totalVotesCast = offices.length > 0
    ? Math.round(perOfficeCounts.reduce((sum, r) => sum + r.count, 0) / offices.length)
    : 0;
  const candidateVoteMap = new Map(perCandidateCounts.map(r => [r._id.toString(), r.count]));
  const confirmMap = new Map<string, { approve: number; reject: number }>();
  for (const r of confirmationCounts) {
    const oid = r._id.officeId.toString();
    if (!confirmMap.has(oid)) confirmMap.set(oid, { approve: 0, reject: 0 });
    const entry = confirmMap.get(oid)!;
    if (r._id.choice === 'approve') entry.approve = r.count;
    else entry.reject = r.count;
  }

  const candidatesByOffice = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const oid = c.officeId.toString();
    if (!candidatesByOffice.has(oid)) candidatesByOffice.set(oid, []);
    candidatesByOffice.get(oid)!.push(c);
  }

  const officeBreakdown = offices.map(office => {
    const oid = office._id.toString();
    const officeCandidates = candidatesByOffice.get(oid) ?? [];
    const voteType = officeCandidates.length === 1 ? 'confirmation' : 'competitive';
    const totalOfficeVotes = officeVoteMap.get(oid) ?? 0;

    if (voteType === 'confirmation') {
      const conf = confirmMap.get(oid) ?? { approve: 0, reject: 0 };
      return {
        officeId: oid,
        officeTitle: office.title,
        voteType,
        totalVotes: totalOfficeVotes,
        approveCount: conf.approve,
        rejectCount: conf.reject,
        candidates: [],
      };
    }

    return {
      officeId: oid,
      officeTitle: office.title,
      voteType,
      totalVotes: totalOfficeVotes,
      candidates: officeCandidates.map(c => ({
        candidateId: c._id.toString(),
        fullName: c.fullName,
        voteCount: candidateVoteMap.get(c._id.toString()) ?? 0,
      })),
    };
  });

  sendSuccess(res, {
    totalVotesCast,
    officeBreakdown,
    fetchedAt: new Date().toISOString(),
  });
});