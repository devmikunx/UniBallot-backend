import crypto from "crypto";
import mongoose from "mongoose";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";
import Election from "../models/Election";
import Office from "../models/Office";
import Candidate from "../models/Candidate";
import RegisteredVoter from "../models/RegisteredVoter";
import Vote from "../models/Vote";
import { logAction } from "./audit.service";
import { AUDIT_ACTIONS } from "../config/constants";
import { voteLimit } from "../server";
import { redis } from "../config/redis";

export interface VoteSubmission {
  officeId: string;
  candidateId?: string;
  confirmationChoice?: "approve" | "reject";
}

function computeVoteHash(
  electionId: string,
  officeId: string,
  choiceKey: string,
  submittedAtISO: string,
): string {
  return crypto
    .createHash("sha256")
    .update(
      `${electionId}${officeId}${choiceKey}${submittedAtISO}${env.VOTE_HASH_SECRET}`,
    )
    .digest("hex");
}

interface BallotData {
  election: {
    _id: string;
    status: string;
    isLocked: boolean;
    electionMode?: string;
  };
  offices: Array<{ _id: string; title: string; description?: string }>;
  candidates: Array<{
    _id: string;
    officeId: string;
    fullName: string;
    bio?: string;
    photoUrl?: string;
  }>;
}

export async function getBallotData(electionId: string): Promise<BallotData> {
  const cacheKey = `ballot:${electionId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as BallotData;
  } catch {}

  const [election, offices] = await Promise.all([
    Election.findById(electionId).lean(),
    Office.find({ electionId }).lean(),
  ]);

  if (!election) throw new AppError(404, "Election not found");

  const candidates = await Candidate.find({
    officeId: { $in: offices.map((o) => o._id) },
  }).lean();

  const data: BallotData = {
    election: {
      _id: election._id.toString(),
      status: election.status,
      isLocked: election.isLocked,
      electionMode: election.electionMode,
    },
    offices: offices.map((o) => ({
      _id: o._id.toString(),
      title: o.title,
      description: o.description,
    })),
    candidates: candidates.map((c) => ({
      _id: c._id.toString(),
      officeId: c.officeId.toString(),
      fullName: c.fullName,
      bio: c.bio,
      photoUrl: c.photoUrl,
    })),
  };

  await redis.setEx(cacheKey, 300, JSON.stringify(data)).catch(() => null);
  return data;
}

const VOTER_CACHE_TTL = 3600;

async function isVoterRegistered(
  electionId: string,
  userId: string,
): Promise<{ registered: boolean; hasVoted: boolean }> {
  const key = `voter:${electionId}:${userId}`;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
  } catch {}

  const voter = await RegisteredVoter.findOne(
    { electionId, userId },
    { hasVoted: 1 },
  ).lean();

  const result = voter
    ? { registered: true, hasVoted: voter.hasVoted }
    : { registered: false, hasVoted: false };

  if (result.registered) {
    await redis
      .setEx(key, VOTER_CACHE_TTL, JSON.stringify(result))
      .catch(() => null);
  }

  return result;
}

export async function getBallot(electionId: string, userId: string) {
  const { election, offices, candidates } = await getBallotData(electionId);

  if (election.status !== "voting_open")
    throw new AppError(400, "Voting is not open");
  if (election.isLocked) throw new AppError(423, "Election is in lockdown");

  const voterStatus = await isVoterRegistered(electionId, userId);
  if (!voterStatus.registered)
    throw new AppError(403, "You are not registered for this election");
  if (voterStatus.hasVoted) throw new AppError(409, "You have already voted");

  const candidatesByOffice = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!candidatesByOffice.has(c.officeId))
      candidatesByOffice.set(c.officeId, []);
    candidatesByOffice.get(c.officeId)!.push(c);
  }

  return {
    isLocked: election.isLocked,
    lockdownMessage: election.isLocked
      ? "Election in emergency lockdown"
      : undefined,
    offices: offices.map((office) => {
      const officeCandidates = candidatesByOffice.get(office._id) ?? [];
      const voteType =
        officeCandidates.length === 1 ? "confirmation" : "competitive";
      return {
        officeId: office._id,
        officeTitle: office.title,
        officeDescription: office.description,
        voteType,
        candidates: officeCandidates.map((c) => ({
          candidateId: c._id,
          fullName: c.fullName,
          bio: c.bio,
          photoUrl: c.photoUrl,
        })),
        options:
          voteType === "confirmation" ? ["approve", "reject"] : undefined,
      };
    }),
  };
}

export function submitBallot(
  electionId: string,
  userId: string,
  votes: VoteSubmission[],
): Promise<{ receiptCode: string }> {
  return voteLimit(() => _submitBallot(electionId, userId, votes));
}

async function _submitBallot(
  electionId: string,
  userId: string,
  votes: VoteSubmission[],
): Promise<{ receiptCode: string }> {
  const voterCheck = await isVoterRegistered(electionId, userId);

  if (!voterCheck.registered)
    throw new AppError(403, "You are not registered for this election");
  if (voterCheck.hasVoted) throw new AppError(409, "You have already voted");

  const { election, offices, candidates } = await getBallotData(electionId);

  if (election.status !== "voting_open")
    throw new AppError(400, "Voting is not open");
  if (election.isLocked) throw new AppError(423, "Election is in lockdown");

  const officeIds = offices.map((o) => o._id);
  const submittedIds = votes.map((v) => v.officeId);

  const missing = officeIds.filter((id) => !submittedIds.includes(id));
  const extra = submittedIds.filter((id) => !officeIds.includes(id));
  const dupes = submittedIds.filter((id, i) => submittedIds.indexOf(id) !== i);

  if (missing.length || extra.length || dupes.length) {
    throw new AppError(
      400,
      `Ballot mismatch. Missing: [${missing.join(", ")}] Extra: [${extra.join(", ")}] Duplicates: [${dupes.join(", ")}]`,
    );
  }

  const candidatesByOffice = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!candidatesByOffice.has(c.officeId))
      candidatesByOffice.set(c.officeId, []);
    candidatesByOffice.get(c.officeId)!.push(c);
  }

  const officeMap = new Map(offices.map((o) => [o._id, o]));

  for (const vote of votes) {
    const office = officeMap.get(vote.officeId);
    if (!office) throw new AppError(400, `Unknown officeId: ${vote.officeId}`);

    const officeCandidates = candidatesByOffice.get(office._id) ?? [];
    const voteType =
      officeCandidates.length === 1 ? "confirmation" : "competitive";

    if (voteType === "competitive") {
      if (!vote.candidateId) {
        throw new AppError(
          400,
          `candidateId required for competitive office "${office.title}"`,
        );
      }
      if (!officeCandidates.some((c) => c._id === vote.candidateId)) {
        throw new AppError(
          400,
          `Invalid candidateId for office "${office.title}"`,
        );
      }
    } else {
      if (
        !vote.confirmationChoice ||
        !["approve", "reject"].includes(vote.confirmationChoice)
      ) {
        throw new AppError(
          400,
          `confirmationChoice must be 'approve' or 'reject' for office "${office.title}"`,
        );
      }
    }
  }

  const ballotToken = crypto.randomUUID();
  const submittedAt = new Date();
  const receiptCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  const electionOid = new mongoose.Types.ObjectId(electionId);

  const voteDocs = votes.map((vote) => {
    const choiceKey = vote.candidateId ?? vote.confirmationChoice ?? "";
    return {
      electionId: electionOid,
      officeId: new mongoose.Types.ObjectId(vote.officeId),
      candidateId: vote.candidateId
        ? new mongoose.Types.ObjectId(vote.candidateId)
        : undefined,
      confirmationChoice: vote.confirmationChoice,
      ballotToken,
      voteHash: computeVoteHash(
        electionId,
        vote.officeId,
        choiceKey,
        submittedAt.toISOString(),
      ),
      createdAt: submittedAt,
    };
  });

  try {
    await Vote.insertMany(voteDocs, { ordered: false });
  } catch (err) {
    const isDupKey = (e: unknown): boolean => {
      if (typeof e !== "object" || e === null) return false;
      const code = (e as { code?: number }).code;
      const writeErrors = (e as { writeErrors?: Array<{ code?: number }> })
        .writeErrors;
      if (code === 11000) return true;
      if (
        Array.isArray(writeErrors) &&
        writeErrors.some((w) => w.code === 11000)
      )
        return true;
      return false;
    };
    if (isDupKey(err))
      throw new AppError(
        409,
        "Your vote was already recorded",
        "VOTE_ALREADY_RECORDED",
      );
    throw err;
  }

  const votedVoter = await RegisteredVoter.findOneAndUpdate(
    { electionId, userId, hasVoted: false },
    {
      $set: { hasVoted: true, ballotToken, receiptCode, votedAt: submittedAt },
    },
    { new: true },
  );

  if (!votedVoter) {
    throw new AppError(409, "You have already voted in this election");
  }

  await redis
    .setEx(
      `voter:${electionId}:${userId}`,
      VOTER_CACHE_TTL,
      JSON.stringify({ registered: true, hasVoted: true }),
    )
    .catch(() => null);

  logAction({
    action: AUDIT_ACTIONS.VOTE_SUBMITTED,
    performedBy: userId,
    targetId: electionOid,
    targetModel: "Vote",
    metadata: { electionId, votedAt: submittedAt.toISOString() },
  }).catch((e) => console.error("[audit] failed to write vote audit log:", e));

  return { receiptCode };
}
