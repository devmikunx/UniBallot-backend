import { Request, Response } from "express";
import { z } from "zod";
import Office from "../models/Office";
import Candidate from "../models/Candidate";
import Vote from "../models/Vote";
import Election from "../models/Election";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/apiResponse";
import { logAction } from "../services/audit.service";
import { deleteImage } from "../services/upload.service";
import { AUDIT_ACTIONS } from "../config/constants";

export const officeSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
});

export const createOffice = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    const isAnon = election.electionMode === 'anonymous';
    const allowedStatuses = isAnon
      ? ['setup', 'paused']
      : ['setup', 'registration_open', 'registration_closed'];
    if (!allowedStatuses.includes(election.status)) {
      throw new AppError(400, isAnon
        ? 'Offices can only be created during setup or while voting is paused'
        : 'Offices can only be created in setup or registration_open status');
    }

    if (election.candidatesLocked)
      throw new AppError(409, "Candidates are locked");

    const { title, description } = req.body as z.infer<typeof officeSchema>;

    const existingOffice = await Office.findOne({
      electionId: election._id,
      title: title.trim(),
    });
    if (existingOffice)
      throw new AppError(
        409,
        "An office with this title already exists in the election",
      );

    const office = await Office.create({
      electionId: election._id,
      title,
      description,
    });

    await logAction({
      action: AUDIT_ACTIONS.OFFICE_CREATED,
      performedBy: req.user._id,
      targetId: office._id,
      targetModel: "Office",
    });

    sendSuccess(res, office, "Office created", 201);
  },
);

export const listOffices = asyncHandler(async (req: Request, res: Response) => {
  const { id: electionId } = req.params;

  const offices = await Office.find({ electionId }).lean();

  if (offices.length === 0) return sendSuccess(res, [], 'No offices found');

  const allCandidates = await Candidate.find(
    { officeId: { $in: offices.map(o => o._id) } }
  ).lean();

  const byOffice = new Map<string, typeof allCandidates>();
  for (const candidate of allCandidates) {
    const key = candidate.officeId.toString();
    if (!byOffice.has(key)) byOffice.set(key, []);
    byOffice.get(key)!.push(candidate);
  }

  const withCandidates = offices.map(office => ({
    ...office,
    candidates: byOffice.get(office._id.toString()) ?? [],
    candidateCount: (byOffice.get(office._id.toString()) ?? []).length,
  }));

  return sendSuccess(res, withCandidates, 'Offices retrieved');
});

export const updateOffice = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    const isAnon = election.electionMode === 'anonymous';
    const editBlocked = isAnon
      ? ['voting_open', 'voting_closed', 'results_published'].includes(election.status)
      : election.candidatesLocked;
    if (editBlocked) throw new AppError(409, 'Candidates cannot be modified at this stage');
    if (isAnon && election.status === 'paused') {
      logAction({ action: AUDIT_ACTIONS.CANDIDATE_EDITED_DURING_PAUSE, performedBy: req.user._id, targetId: election._id, targetModel: 'Election', metadata: { action: 'office_updated' } }).catch(() => null);
    }

    const { title, description } = req.body as Partial<
      z.infer<typeof officeSchema>
    >;

    const updateFields: Record<string, string> = {};
    if (title !== undefined) updateFields.title = title;
    if (description !== undefined) updateFields.description = description;

    const office = await Office.findOneAndUpdate(
      { _id: req.params.officeId, electionId: election._id },
      { $set: updateFields },
      { new: true, runValidators: true },
    );
    if (!office) throw new AppError(404, "Office not found");

    sendSuccess(res, office, "Office updated");
  },
);

export const deleteOffice = asyncHandler(
  async (req: Request, res: Response) => {
    const election = await Election.findById(req.params.id);
    if (!election) throw new AppError(404, "Election not found");

    const isAnon = election.electionMode === 'anonymous';
    const editBlocked = isAnon
      ? ['voting_open', 'voting_closed', 'results_published'].includes(election.status)
      : election.candidatesLocked;
    if (editBlocked) throw new AppError(409, 'Candidates cannot be modified at this stage');
    if (isAnon && election.status === 'paused') {
      logAction({ action: AUDIT_ACTIONS.CANDIDATE_EDITED_DURING_PAUSE, performedBy: req.user._id, targetId: election._id, targetModel: 'Election', metadata: { action: 'office_deleted' } }).catch(() => null);
    }

    const office = await Office.findOne({
      _id: req.params.officeId,
      electionId: election._id,
    });
    if (!office) throw new AppError(404, "Office not found");

    const voteExists = await Vote.findOne({ officeId: office._id });
    if (voteExists)
      throw new AppError(409, "Cannot delete an office that has votes");

    const candidates = await Candidate.find({ officeId: office._id });
    await Promise.all(
      candidates
        .filter(c => c.photoPublicId)
        .map(c => deleteImage(c.photoPublicId!).catch(() => null))
    );
    await Candidate.deleteMany({ officeId: office._id });
    await Office.findByIdAndDelete(office._id);

    await logAction({
      action: AUDIT_ACTIONS.OFFICE_DELETED,
      performedBy: req.user._id,
      targetId: office._id,
      targetModel: "Office",
    });

    res.status(204).send();
  },
);
