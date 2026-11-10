import { Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import mongoose from "mongoose";
import Election from "../models/Election";
import Association from "../models/Association";
import AssociationMember from "../models/AssociationMember";
import Office from "../models/Office";
import Candidate from "../models/Candidate";
import RegisteredVoter from "../models/RegisteredVoter";
import Vote from "../models/Vote";
import User from "../models/User";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess, sendPaginated } from "../utils/apiResponse";
import { generateElectionCode } from "../utils/generateCode";
import { logAction } from "../services/audit.service";
import {
  AUDIT_ACTIONS,
  ELECTION_STATUS_ORDER,
  ElectionStatus,
} from "../config/constants";
import { computeTally, getCachedTally } from "../services/results.service";
import { redis } from "../config/redis";
import { generateCsv, streamPdf } from "../services/export.service";
import {
  sendEmail,
  officerElectionAssignedTemplate,
  voterRegistrationConfirmationTemplate,
  resultsPublishedOfficerTemplate,
} from "../services/email/email.service";
import type { IElection } from "../models/Election";
import { env } from "../config/env";

const MAX_OFFICER_CONCURRENT_ELECTIONS = parseInt(
  process.env.MAX_OFFICER_CONCURRENT_ELECTIONS || "3",
  10,
);

export const createElectionSchema = z.object({
  associationId: z.string().min(1).optional(),
  title: z.string().min(2),
  description: z.string().optional(),
});

interface MyElectionResult extends Omit<IElection, "reg"> {
  hasVoted?: boolean;
  association?: { _id: string; name: string };
}

export const createElection = asyncHandler(
  async (req: Request, res: Response) => {
    const { associationId, title, description } = req.body as z.infer<
      typeof createElectionSchema
    >;

    if (req.user.role === 'public_creator') {
      const slug = title.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).padStart(6, 'X');
      let electionCode = '';
      for (let i = 0; i < 5; i++) {
        const candidate = slug + crypto.randomBytes(1).toString('hex').toUpperCase();
        const clash = await Election.findOne({ electionCode: candidate });
        if (!clash) { electionCode = candidate; break; }
      }
      // FIX 1: generateElectionCode is async — must be awaited
      if (!electionCode) electionCode = await generateElectionCode();

      const election = await Election.create({
        title:           title.trim(),
        description:     description?.trim(),
        electionCode,
        status:          'draft',
        electionMode:    'anonymous',
        createdByPublic: req.user._id,
      });

      await logAction({
        action:      AUDIT_ACTIONS.ANON_ELECTION_CREATED,
        performedBy: req.user._id,
        targetId:    election._id,
        targetModel: 'Election',
      });

      return sendSuccess(res, election, 'Anonymous election created', 201);
    }

    const association = await Association.findById(associationId);
    if (!association) throw new AppError(404, "Association not found");

    const electionCode = await generateElectionCode();
    const election = await Election.create({
      associationId,
      title,
      description,
      electionCode,
      status: "draft",
    });

    await logAction({
      action: AUDIT_ACTIONS.ELECTION_CREATED,
      performedBy: req.user._id,
      targetId: election._id,
      targetModel: "Election",
    });

    // FIX 2: missing return — without it TS sees a code path with no return value
    return sendSuccess(res, election, "Election created", 201);
  },
);

export const listElections = asyncHandler(
  async (req: Request, res: Response) => {
    const {
      page = "1",
      limit = "20",
      associationId,
      status,
      search,
    } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = {};
    if (req.user.role === "officer") filter.assignedOfficerId = req.user._id;
    if (associationId)
      filter.associationId = new mongoose.Types.ObjectId(associationId);
    if (status) filter.status = status;
    if (search) {
      const escaped = (search as string)
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.title = { $regex: "^" + escaped, $options: "i" };
    }

    const [elections, total] = await Promise.all([
      Election.find(filter)
        .select('-results -integrityResult')
        .populate("associationId", "name")
        .populate("assignedOfficerId", "fullName email")
        .skip(skip)
        .limit(limitNum)
        .sort({ createdAt: -1 })
        .lean(),
      Election.countDocuments(filter),
    ]);

    sendPaginated(res, elections, total, pageNum, limitNum);
  },
);

export const getElection = asyncHandler(async (req: Request, res: Response) => {
  const election = await Election.findById(req.params.id)
    .populate("associationId", "name")
    .populate("assignedOfficerId", "fullName email");
  if (!election) throw new AppError(404, "Election not found");
  sendSuccess(res, election);
});

export const getElectionByCode = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findOne({
      electionCode: req.params.code.toUpperCase(),
    }).populate<{ associationId: { name: string } }>("associationId", "name");
    if (!election) throw new AppError(404, "Election not found");

    sendSuccess(res, {
      _id:             election._id,
      title:           election.title,
      associationName: election.associationId ? (election.associationId as { name: string }).name : null,
      status:          election.status,
      electionCode:    election.electionCode,
      electionMode:    election.electionMode,
    });
  },
);

const OPEN_ELECTIONS_CACHE_KEY = 'open-elections';

export const getOpenElections = asyncHandler(
  async (_req: Request, res: Response) => {
    const cached = await redis.get(OPEN_ELECTIONS_CACHE_KEY).catch(() => null);
    if (cached) return sendSuccess(res, JSON.parse(cached), 'Open elections retrieved');

    const elections = await Election.find({
      status: { $in: ["registration_open", "voting_open"] },
      isLocked: false,
    })
      .populate<{ associationId: { name: string } }>("associationId", "name")
      .sort({ createdAt: -1 })
      .lean();

    const safe = elections.map((e) => ({
      title: e.title,
      associationName: (e.associationId as unknown as { name: string }).name,
      electionCode: e.electionCode,
      status: e.status,
    }));

    await redis.setEx(OPEN_ELECTIONS_CACHE_KEY, 60, JSON.stringify(safe)).catch(() => null);
    return sendSuccess(res, safe, 'Open elections retrieved');
  },
);

export const updateElection = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");
    if (!["draft", "setup"].includes(election.status)) {
      throw new AppError(
        400,
        "Election can only be updated in draft or setup status",
      );
    }

    const { title, description } = req.body as {
      title?: string;
      description?: string;
    };
    const updateFields: Record<string, string> = {};
    if (title !== undefined) updateFields.title = title;
    if (description !== undefined) updateFields.description = description;

    const updated = await Election.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true, runValidators: true },
    );
    sendSuccess(res, updated, "Election updated");
  },
);

export const assignOfficer = asyncHandler(
  async (req: Request, res: Response) => {
    const { officerId } = req.body as { officerId: string };

    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    const officer = await User.findById(officerId);
    if (!officer || officer.role !== "officer")
      throw new AppError(400, "User is not an officer");
    if (!officer.isActive || officer.isSuspended)
      throw new AppError(400, "Officer account is not active");

    const activeCount = await Election.countDocuments({
      assignedOfficerId: officerId,
      _id: { $ne: election._id },
      status: { $ne: "results_published" },
    });
    if (activeCount >= MAX_OFFICER_CONCURRENT_ELECTIONS) {
      throw new AppError(
        409,
        `Officer is already assigned to ${activeCount} active election(s) (max: ${MAX_OFFICER_CONCURRENT_ELECTIONS})`,
      );
    }

    await Election.findByIdAndUpdate(election._id, {
      $set: { assignedOfficerId: officerId },
    });

    await logAction({
      action: AUDIT_ACTIONS.OFFICER_ASSIGNED,
      performedBy: req.user._id,
      targetId: election._id,
      targetModel: "Election",
      metadata: { officerId },
    });

    if (officer.email && officer.fullName) {
      sendEmail({
        to: officer.email,
        ...officerElectionAssignedTemplate(
          officer.fullName,
          election.title,
          election.electionCode,
        ),
      }).catch(() => null);
    }

    sendSuccess(res, null, "Officer assigned");
  },
);

export const transitionStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const { status: newStatus } = req.body as { status: string };

    if (!ELECTION_STATUS_ORDER.includes(newStatus as ElectionStatus)) {
      throw new AppError(400, `Invalid status value: ${newStatus}`);
    }
    const typedStatus = newStatus as ElectionStatus;

    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");
    if (election.isLocked)
      throw new AppError(
        423,
        "Election is in lockdown — deactivate lockdown first",
      );

    const isAnon = election.electionMode === 'anonymous';

    if (isAnon && ['registration_open', 'registration_closed'].includes(typedStatus)) {
      throw new AppError(400, 'Registration steps are not valid for anonymous elections');
    }
    if (!isAnon && typedStatus === 'paused') {
      throw new AppError(400, 'The paused status is only valid for anonymous elections');
    }

    // For anonymous elections, registration_open and registration_closed are
    // skipped entirely. Build a filtered order so that index arithmetic
    // correctly treats draft → setup → voting_open as consecutive steps.
    // paused is excluded from the linear order — it is a side-branch off
    // voting_open, so voting_open → paused → voting_open and
    // paused → voting_closed must all be valid without breaking ±1 arithmetic.
    const ANON_SKIP = ['registration_open', 'registration_closed'];
    const LINEAR_SKIP = isAnon ? [...ANON_SKIP, 'paused'] : [];
    const effectiveOrder = ELECTION_STATUS_ORDER.filter((s) => !LINEAR_SKIP.includes(s));

    const isPauseTransition =
      isAnon &&
      ((election.status === 'voting_open' && typedStatus === 'paused') ||
        (election.status === 'paused' && typedStatus === 'voting_open'));

    const linearCurrent = election.status === 'paused' ? 'voting_open' : election.status;
    const currentIdx = effectiveOrder.indexOf(linearCurrent);
    const newIdx = effectiveOrder.indexOf(typedStatus);

    if (!isPauseTransition && newIdx === currentIdx - 1) {
      if (typedStatus === "registration_open") {
        const memberCount = await AssociationMember.countDocuments({
          electionId: election._id,
        });
        if (memberCount === 0)
          throw new AppError(
            400,
            "Cannot go back to registration_open: no members uploaded",
          );
      }
    } else if (!isPauseTransition && newIdx === currentIdx + 1) {
      if (typedStatus === "registration_open") {
        const memberCount = await AssociationMember.countDocuments({
          electionId: election._id,
        });
        if (memberCount === 0)
          throw new AppError(
            400,
            "Upload at least one member before opening registration",
          );
      }

      if (typedStatus === "voting_open") {
        const offices = await Office.find({ electionId: election._id });
        if (offices.length === 0)
          throw new AppError(400, "At least one office is required");

        const officeIds = offices.map((o) => o._id);

        const candidateCounts: Array<{ _id: string; count: number }> = await Candidate.aggregate([
          { $match: { officeId: { $in: officeIds } } },
          { $group: { _id: '$officeId', count: { $sum: 1 } } },
        ]);

        const countByOffice = new Map(
          candidateCounts.map((r) => [r._id.toString(), r.count])
        );

        const emptyOffices = offices.filter(
          (o) => (countByOffice.get(o._id.toString()) ?? 0) === 0
        );

        if (emptyOffices.length > 0) {
          throw new AppError(
            400,
            `Cannot open voting — the following offices have no candidates: ${emptyOffices.map((o) => o.title).join(', ')}`,
          );
        }
      }
    } else if (!isPauseTransition) {
      throw new AppError(
        400,
        "Status transitions are only allowed one step forward or one step backward",
      );
    }

    if (typedStatus === "results_published") {
      throw new AppError(
        400,
        "Use POST /elections/:id/publish-results to publish results.",
        "USE_PUBLISH_ENDPOINT",
      );
    }

    const updateFields: Record<string, unknown> = { status: typedStatus };
    if (typedStatus === 'voting_open' && !isAnon) {
      updateFields.candidatesLocked = true;
      updateFields.membersLocked    = true;
    }
    if (typedStatus === 'paused') {
      updateFields.candidatesLocked = false;
    }

    const updated = await Election.findByIdAndUpdate(
      election._id,
      { $set: updateFields },
      { new: true },
    )
      .populate("associationId", "name")
      .populate("assignedOfficerId", "fullName email");

    await logAction({
      action: AUDIT_ACTIONS.STATUS_CHANGED,
      performedBy: req.user._id,
      targetId: election._id,
      targetModel: "Election",
      metadata: { from: election.status, to: typedStatus },
    });

    await redis.del(`ballot:${election._id}`).catch(() => null);

    sendSuccess(res, updated, `Election status changed to ${typedStatus}`);
  },
);

export const toggleLockdown = asyncHandler(
  async (req: Request, res: Response) => {
    const { active } = req.body as { active: boolean };
    const election = await Election.findByIdAndUpdate(
      req.params.id,
      { $set: { isLocked: active } },
      { new: true },
    );
    if (!election) throw new AppError(404, "Election not found");

    const action = active
      ? AUDIT_ACTIONS.LOCKDOWN_ACTIVATED
      : AUDIT_ACTIONS.LOCKDOWN_DEACTIVATED;
    await logAction({
      action,
      performedBy: req.user._id,
      targetId: election._id,
      targetModel: "Election",
    });
    await redis.del(`ballot:${req.params.id}`).catch(() => null);

    sendSuccess(res, null, `Lockdown ${active ? "activated" : "deactivated"}`);
  },
);

export const registerForElection = asyncHandler(
  async (req: Request, res: Response) => {
    const { electionCode } = req.body as { electionCode: string };

    if (!req.user.profileCompleted) {
      throw new AppError(
        400,
        "Complete your profile before registering for elections",
      );
    }
    if (!req.user.matricNumber) {
      throw new AppError(
        400,
        "Your profile must include a matric number to register for elections",
      );
    }

    const election = await Election.findOne({
      electionCode: electionCode.toUpperCase(),
    });
    if (!election) throw new AppError(404, "Election not found");
    if (!["registration_open", "registration_closed", "voting_open"].includes(election.status))
      throw new AppError(400, "Registration is not open for this election");
    if (election.isLocked) throw new AppError(423, "Election is in lockdown");

    const eligible = await AssociationMember.findOne({
      electionId: election._id,
      matricNumber: req.user.matricNumber,
    });
    if (!eligible)
      throw new AppError(
        403,
        "You are not on the eligibility list for this election",
      );

    const existingVoter = await RegisteredVoter.findOneAndUpdate(
      { electionId: election._id, userId: req.user._id },
      {
        $setOnInsert: {
          electionId: election._id,
          userId: req.user._id,
          hasVoted: false,
        },
      },
      { upsert: true, new: false },
    );
    if (existingVoter !== null)
      throw new AppError(409, "You are already registered for this election");

    await logAction({
      action: AUDIT_ACTIONS.VOTER_REGISTERED,
      performedBy: req.user._id,
      targetId: election._id,
      targetModel: "RegisteredVoter",
      metadata: {
        electionId: election._id.toString(),
        matricNumber: req.user.matricNumber,
      },
    });

    User.findById(req.user._id)
      .select("email fullName")
      .lean()
      .then((student) => {
        if (student?.email && student?.fullName) {
          sendEmail({
            to: student.email,
            ...voterRegistrationConfirmationTemplate(
              student.fullName,
              election.title,
              election.electionCode,
            ),
          }).catch(() => null);
        }
      })
      .catch(() => null);

    sendSuccess(res, null, "Successfully registered for election", 201);
  },
);

export const publishResults = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    if (election.status == "results_published") {
      throw new AppError(400, "Election already published");
    }

    if (election.status !== "voting_closed") {
      throw new AppError(400, "Election is not in voting_closed status");
    }

    const tally = await computeTally(election._id.toString());
    if (!tally || tally.length === 0)
      throw new AppError(400, "No votes found for this election");

    const updated = await Election.findOneAndUpdate(
      { _id: election._id, status: "voting_closed" },
      { $set: { results: tally, status: "results_published", published: true } },
      { new: true, runValidators: true },
    );

    if (!updated) {
      const current = await Election.findById(election._id).select("status");
      if (current?.status === "results_published")
        throw new AppError(409, "Results have already been published");
      throw new AppError(
        409,
        "Election status changed during computation — please retry",
      );
    }

    await Promise.all([
      redis.del(`tally:${election._id}`).catch(() => null),
      redis.del(`tally:preview:${election._id}`).catch(() => null),
    ]);
    await redis.setEx(`tally:${election._id}`, 3_600, JSON.stringify(tally)).catch(() => null);

    await logAction({
      action: AUDIT_ACTIONS.RESULTS_PUBLISHED,
      performedBy: req.user._id,
      targetId: election._id,
      targetModel: "Election",
    });

    const hasTies = tally.some((t) => t.isTie);
    const tiedOffices = tally.filter((t) => t.isTie).map((t) => t.officeTitle);

    if (election.assignedOfficerId) {
      User.findById(election.assignedOfficerId)
        .select("email fullName")
        .lean()
        .then((officer) => {
          if (officer?.email && officer?.fullName) {
            sendEmail({
              to: officer.email,
              ...resultsPublishedOfficerTemplate(
                officer.fullName,
                election.title,
                election.electionCode,
                hasTies,
                tiedOffices,
              ),
            }).catch(() => null);
          }
        })
        .catch(() => null);
    }

    sendSuccess(res, { hasTies, tiedOffices }, "Results published");
  },
);

export const getResults = asyncHandler(async (req: Request, res: Response) => {
  const election = await Election.findById(req.params.id);
  if (!election) throw new AppError(404, "Election not found");
  if (election.status !== "results_published")
    throw new AppError(403, "Results are not yet published");

  if (req.user.role === "student") {
    const cacheKey = `voter-result-access:${election._id}:${req.user._id}`;
    const cached   = await redis.get(cacheKey).catch(() => null);

    if (!cached) {
      const isRegistered = await RegisteredVoter.findOne(
        { electionId: election._id, userId: req.user._id },
        { _id: 1 },
      ).lean();
      if (!isRegistered) throw new AppError(403, "Only registered voters can view results");

      await redis.setEx(cacheKey, 86_400, '1').catch(() => null);
    }
  }

  if (req.user.role === "public_creator") {
    const isOwner =
      election.createdByPublic != null &&
      election.createdByPublic.toString() === req.user._id.toString();
    if (!isOwner) throw new AppError(403, "You are not authorized for this election");
  }

  if (election.results?.length) {
    return sendSuccess(res, election.results);
  }

  const cached = await getCachedTally(election._id.toString());
  if (cached) return sendSuccess(res, cached);

  const mutexKey  = `tally-computing:${election._id}`;
  const lockValue = crypto.randomUUID();
  const acquired  = await redis.set(mutexKey, lockValue, { NX: true, EX: 30 }).catch(() => null);

  if (!acquired) {
    await new Promise((r) => setTimeout(r, 800));
    const retried = await getCachedTally(election._id.toString());
    if (retried) return sendSuccess(res, retried);
  }

  const tally = await computeTally(election._id.toString());
  await redis.setEx(`tally:${election._id}`, 3_600, JSON.stringify(tally)).catch(() => null);

  if (acquired) {
    await redis.del(mutexKey).catch(() => null);
  }

  return sendSuccess(res, tally);
});

export const getResultsByCode = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findOne({
      electionCode: req.params.code.toUpperCase(),
    });
    if (!election) throw new AppError(404, "Election not found");
    if (election.status !== "results_published")
      throw new AppError(403, "Results are not yet published");

    if (req.user.role === "student") {
      const isRegistered = await RegisteredVoter.findOne({
        electionId: election._id,
        userId: req.user._id,
      });
      if (!isRegistered)
        throw new AppError(403, "Only registered voters can view results");
    }

    sendSuccess(res, election.results || []);
  },
);

export const previewResults = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");
    if (!["voting_closed", "results_published"].includes(election.status)) {
      throw new AppError(
        400,
        "Results preview is only available after voting has closed",
      );
    }

    const previewKey = `tally:preview:${req.params.id}`;
    const cached = await redis.get(previewKey).catch(() => null);
    if (cached)
      return sendSuccess(res, JSON.parse(cached), "Live preview (cached)");

    const tally = await computeTally(election._id.toString());
    await redis.setEx(previewKey, 60, JSON.stringify(tally)).catch(() => null);
    return sendSuccess(res, tally, "Live preview");
  },
);

export const getAnalytics = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    const validStatuses: ElectionStatus[] = [
      "registration_open",
      "registration_closed",
      "voting_open",
      "voting_closed",
      "results_published",
    ];
    if (!validStatuses.includes(election.status)) {
      throw new AppError(
        400,
        "Analytics are only available from registration_open onwards",
      );
    }

    const [totalMembers, registeredVoters, votesCast, offices, voteCountsRaw] =
      await Promise.all([
        AssociationMember.countDocuments({ electionId: election._id }),
        RegisteredVoter.countDocuments({ electionId: election._id }),
        RegisteredVoter.countDocuments({
          electionId: election._id,
          hasVoted: true,
        }),
        Office.find({ electionId: election._id }),
        Vote.aggregate<{ _id: string; count: number }>([
          { $match: { electionId: election._id } },
          { $group: { _id: "$officeId", count: { $sum: 1 } } },
        ]),
      ]);

    const voteCountMap = new Map(
      voteCountsRaw.map((r) => [r._id.toString(), r.count]),
    );
    const turnoutPercent =
      registeredVoters > 0
        ? Math.round((votesCast / registeredVoters) * 100)
        : 0;
    const officeBreakdown = offices.map((o) => ({
      officeTitle: o.title,
      voteCount: voteCountMap.get(o._id.toString()) ?? 0,
    }));

    sendSuccess(res, {
      totalMembers,
      registeredVoters,
      votesCast,
      turnoutPercent,
      officeBreakdown,
    });
  },
);

export const listMyElections = asyncHandler(
  async (req: Request, res: Response) => {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [result] = await Election.aggregate([
      {
        $lookup: {
          from: "registeredvoters",
          localField: "_id",
          foreignField: "electionId",
          as: "reg",
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    "$userId",
                    new mongoose.Types.ObjectId(req.user._id.toString()),
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
        },
      },
      { $match: { "reg.0": { $exists: true } } },
      {
        $addFields: {
          hasVoted: {
            $ifNull: [{ $arrayElemAt: ["$reg.hasVoted", 0] }, false],
          },
        },
      },
      { $project: { reg: 0, results: 0, integrityResult: 0 } },
      {
        $facet: {
          data: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: limitNum },
            {
              $lookup: {
                from: "associations",
                localField: "associationId",
                foreignField: "_id",
                as: "association",
              },
            },
            { $unwind: { path: "$association", preserveNullAndEmptyArrays: true } },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);

    const elections = result?.data ?? [];
    const total     = result?.total?.[0]?.count ?? 0;

    return sendPaginated(res, elections, total, pageNum, limitNum, 'Elections retrieved');
  },
);

export const deleteElection = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    if (election.status === "results_published") {
      throw new AppError(
        403,
        "Published elections cannot be deleted — they are part of the historical record",
      );
    }

    if (election.status !== "draft") {
      const { force } = req.body as { force?: boolean };
      if (!force) {
        throw new AppError(
          409,
          `Election is in "${election.status}" status and already has data attached. ` +
            'Send { "force": true } to confirm cascade deletion of all attached data.',
        );
      }
    }

    const session = await mongoose.startSession();
    try {
      session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: 30_000,
      });

      await Vote.deleteMany({ electionId: election._id }, { session });
      await RegisteredVoter.deleteMany(
        { electionId: election._id },
        { session },
      );

      const candidates = await Candidate.find(
        { electionId: election._id },
        { photoPublicId: 1 },
      ).session(session);

      await Candidate.deleteMany({ electionId: election._id }, { session });
      await Office.deleteMany({ electionId: election._id }, { session });
      await AssociationMember.deleteMany(
        { electionId: election._id },
        { session },
      );
      await Election.findByIdAndDelete(election._id, { session });

      await session.commitTransaction();

      const { deleteImage } = await import("../services/upload.service");
      let photoFailures = 0;
      for (const candidate of candidates) {
        if (candidate.photoPublicId) {
          try {
            await deleteImage(candidate.photoPublicId);
          } catch {
            photoFailures++;
          }
        }
      }

      await logAction({
        action: AUDIT_ACTIONS.ELECTION_DELETED,
        performedBy: req.user._id,
        targetId: election._id,
        targetModel: "Election",
        metadata: {
          title: election.title,
          deletedStatus: election.status,
          forced: election.status !== "draft",
          photoFailures,
        },
      });
    } catch (err) {
      await session.abortTransaction().catch(() => null);
      throw err;
    } finally {
      session.endSession();
    }

    res.status(204).send();
  },
);

export const exportResultsCsv = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id).populate<{
      associationId: { name: string };
    }>("associationId", "name");
    if (!election) throw new AppError(404, "Election not found");
    if (election.status !== "results_published")
      throw new AppError(400, "Results must be published before exporting");

    const [tally, registeredVoters] = await Promise.all([
      computeTally(election._id.toString()),
      RegisteredVoter.countDocuments({ electionId: election._id }),
    ]);

    const csv = generateCsv(election as unknown as IElection, tally);
    const filename = `election-${election.electionCode}-results.csv`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  },
);

export const exportResultsPdf = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id).populate<{
      associationId: { name: string };
    }>("associationId", "name");
    if (!election) throw new AppError(404, "Election not found");
    if (election.status !== "results_published")
      throw new AppError(400, "Results must be published before exporting");

    const [tally, registeredVoters] = await Promise.all([
      computeTally(election._id.toString()),
      RegisteredVoter.countDocuments({ electionId: election._id }),
    ]);

    const associationName =
      election.associationId?.name ?? "Students Union Government";

    const filename = `election-${election.electionCode}-results.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await streamPdf(election as unknown as IElection, tally, res, {
      institutionName: associationName,
      subBodyName: "Students Union Government",
      registeredVoters,
    });
  },
);

export const togglePublicResults = asyncHandler(async (req: Request, res: Response) => {
  const { enable } = req.body as { enable: boolean };
  const election = req.election!;

  if (enable) {
    if (election.status !== 'results_published') {
      throw new AppError(400, 'Results are not published yet');
    }
    const token = crypto.randomBytes(16).toString('hex');
    await Election.findByIdAndUpdate(election._id, { $set: { resultsPublic: true, resultsToken: token } });
    await logAction({
      action:      AUDIT_ACTIONS.RESULTS_MADE_PUBLIC,
      performedBy: req.user._id,
      targetId:    election._id,
      targetModel: 'Election',
    });
    const origin = env.FRONTEND_ORIGIN.split(',')[0].trim();
    return sendSuccess(res, { resultsPublic: true, publicUrl: `${origin}/results/public/${token}` });
  }

  await Election.findByIdAndUpdate(election._id, { $set: { resultsPublic: false } });
  await logAction({
    action:      AUDIT_ACTIONS.RESULTS_MADE_PRIVATE,
    performedBy: req.user._id,
    targetId:    election._id,
    targetModel: 'Election',
  });
  return sendSuccess(res, { resultsPublic: false });
});

export const listCreatorElections = asyncHandler(async (req: Request, res: Response) => {
  const elections = await Election.find({ createdByPublic: req.user._id })
    .select('-results -integrityResult')
    .sort({ createdAt: -1 })
    .lean();
  sendSuccess(res, elections, 'Elections retrieved');
});