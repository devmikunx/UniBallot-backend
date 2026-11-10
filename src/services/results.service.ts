import type { Types } from 'mongoose';
import Office from '../models/Office';
import Candidate from '../models/Candidate';
import Vote from '../models/Vote';
import { redis } from '../config/redis';

export interface CandidateTally {
  candidateId: string;
  fullName:    string;
  voteCount:   number;
  photoUrl?:   string | null;
}

export interface OfficeTally {
  officeId:      string;
  officeTitle:   string;
  voteType:      'competitive' | 'confirmation';
  totalVotes:    number;
  noVotes:       boolean;
  isTie:         boolean;
  winner?:       string | null;
  elected?:      boolean | null;
  approveCount?: number;
  rejectCount?:  number;
  candidates:    CandidateTally[];
}

export async function computeTally(
  electionId: string | Types.ObjectId
): Promise<OfficeTally[]> {

  // Fetch offices first, then batch-load candidates and votes in parallel
  const offices = await Office.find({ electionId });
  const officeIds = offices.map((o) => o._id);

  const [allCandidates, allVotes] = await Promise.all([
    Candidate.find({ officeId: { $in: officeIds } }),
    Vote.find({ electionId }).select('officeId candidateId confirmationChoice').lean(),
  ]);

  // Group candidates and votes by officeId for O(1) lookup
  const candidatesByOffice = new Map<string, typeof allCandidates>();
  for (const c of allCandidates) {
    const key = c.officeId.toString();
    if (!candidatesByOffice.has(key)) candidatesByOffice.set(key, []);
    candidatesByOffice.get(key)!.push(c);
  }

  const votesByOffice = new Map<string, typeof allVotes>();
  for (const v of allVotes) {
    const key = v.officeId.toString();
    if (!votesByOffice.has(key)) votesByOffice.set(key, []);
    votesByOffice.get(key)!.push(v);
  }

  const tallies: OfficeTally[] = [];

  for (const office of offices) {
    const candidates = candidatesByOffice.get(office._id.toString()) ?? [];
    const votes      = votesByOffice.get(office._id.toString())      ?? [];

    if (votes.length === 0) {
      tallies.push({
        officeId:    office._id.toString(),
        officeTitle: office.title,
        voteType:    candidates.length === 1 ? 'confirmation' : 'competitive',
        totalVotes:  0,
        noVotes:     true,
        isTie:       false,
        winner:      null,
        elected:     null,
        candidates:  candidates.map((c) => ({ candidateId: c._id.toString(), fullName: c.fullName, voteCount: 0, photoUrl: c.photoUrl ?? null })),
      });
      continue;
    }

    if (candidates.length === 1) {
      // Confirmation ballot
      const approveCount = votes.filter((v) => v.confirmationChoice === 'approve').length;
      const rejectCount  = votes.filter((v) => v.confirmationChoice === 'reject').length;
      const totalVotes   = approveCount + rejectCount;
      const isTie        = approveCount === rejectCount;

      tallies.push({
        officeId:    office._id.toString(),
        officeTitle: office.title,
        voteType:    'confirmation',
        totalVotes,
        noVotes:     false,
        isTie,
        elected:     isTie ? null : approveCount > rejectCount,
        approveCount,
        rejectCount,
        candidates: [{ candidateId: candidates[0]._id.toString(), fullName: candidates[0].fullName, voteCount: totalVotes, photoUrl: candidates[0].photoUrl ?? null }],
      });
    } else {
      // Competitive ballot
      const countMap: Record<string, { fullName: string; count: number; photoUrl?: string | null }> = {};
      for (const c of candidates) {
        countMap[c._id.toString()] = { fullName: c.fullName, count: 0, photoUrl: c.photoUrl ?? null };
      }
      for (const v of votes) {
        if (v.candidateId) {
          const id = v.candidateId.toString();
          if (countMap[id]) countMap[id].count++;
        }
      }

      const sorted = Object.entries(countMap)
        .map(([id, data]) => ({ candidateId: id, fullName: data.fullName, voteCount: data.count, photoUrl: data.photoUrl ?? null }))
        .sort((a, b) => b.voteCount - a.voteCount);

      const isTie = sorted.length >= 2 && sorted[0].voteCount === sorted[1].voteCount;

      tallies.push({
        officeId:    office._id.toString(),
        officeTitle: office.title,
        voteType:    'competitive',
        totalVotes:  votes.length,
        noVotes:     false,
        isTie,
        winner:      isTie ? null : (sorted[0]?.candidateId ?? null),
        candidates:  sorted,
      });
    }
  }

  return tallies;
}

export async function getCachedTally(electionId: string): Promise<OfficeTally[] | null> {
  try {
    const raw = await redis.get(`tally:${electionId}`);
    return raw ? (JSON.parse(raw) as OfficeTally[]) : null;
  } catch {
    return null;
  }
}