import { Request, Response } from "express";
import { z } from "zod";
import Candidate from "../models/Candidate";
import Office from "../models/Office";
import Election from "../models/Election";
import Vote from "../models/Vote";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/apiResponse";
import { logAction } from "../services/audit.service";
import { uploadCandidatePhoto, deleteImage } from "../services/upload.service";
import { AUDIT_ACTIONS, CLOUDINARY_FOLDERS } from "../config/constants";

export const candidateSchema = z.object({
  fullName: z.string().min(2),
  bio: z.string().optional(),
});

export const addCandidate = asyncHandler(
  async (req: Request, res: Response) => {
    const office = await Office.findById(req.params.officeId);
    if (!office) throw new AppError(404, "Office not found");

    const election = await Election.findById(office.electionId);
    if (!election) throw new AppError(404, "Election not found");

    const isAnon = election.electionMode === 'anonymous';
    const editBlocked = isAnon
      ? ['voting_open', 'voting_closed', 'results_published'].includes(election.status)
      : election.candidatesLocked;
    if (editBlocked) throw new AppError(409, 'Candidates cannot be modified at this stage');
    if (isAnon && election.status === 'paused') {
      logAction({ action: AUDIT_ACTIONS.CANDIDATE_EDITED_DURING_PAUSE, performedBy: req.user._id, targetId: election._id, targetModel: 'Election', metadata: { action: 'candidate_added' } }).catch(() => null);
    }

    const { fullName, bio } = req.body as z.infer<typeof candidateSchema>;

    const candidate = await Candidate.create({
      officeId: office._id,
      electionId: election._id,
      fullName,
      bio,
    });

    if (req.file) {
      const { url, publicId } = await uploadCandidatePhoto(
        req.file.buffer,
        CLOUDINARY_FOLDERS.CANDIDATES,
        candidate._id.toString(),
      );
      await Candidate.findByIdAndUpdate(candidate._id, {
        $set: { photoUrl: url, photoPublicId: publicId },
      });
      candidate.photoUrl = url;
      candidate.photoPublicId = publicId;
    }

    await logAction({
      action: AUDIT_ACTIONS.CANDIDATE_ADDED,
      performedBy: req.user._id,
      targetId: candidate._id,
      targetModel: "Candidate",
    });

    sendSuccess(res, candidate, "Candidate added", 201);
  },
);

export const listCandidates = asyncHandler(
  async (req: Request, res: Response) => {
    const candidates = await Candidate.find({ officeId: req.params.officeId });
    sendSuccess(res, candidates);
  },
);

export const updateCandidate = asyncHandler(
  async (req: Request, res: Response) => {
    const candidate = await Candidate.findById(req.params.candidateId);
    if (!candidate) throw new AppError(404, "Candidate not found");

    const election = await Election.findById(candidate.electionId);
    if (!election) throw new AppError(404, "Election not found");

    const isAnon = election.electionMode === 'anonymous';
    const editBlocked = isAnon
      ? ['voting_open', 'voting_closed', 'results_published'].includes(election.status)
      : election.candidatesLocked;
    if (editBlocked) throw new AppError(409, 'Candidates cannot be modified at this stage');
    if (isAnon && election.status === 'paused') {
      logAction({ action: AUDIT_ACTIONS.CANDIDATE_EDITED_DURING_PAUSE, performedBy: req.user._id, targetId: election._id, targetModel: 'Election', metadata: { action: 'candidate_updated' } }).catch(() => null);
    }

    const { fullName, bio } = req.body as Partial<
      z.infer<typeof candidateSchema>
    >;

    const updateFields: Record<string, string | undefined> = {};
    if (fullName !== undefined) updateFields.fullName = fullName;
    if (bio !== undefined) updateFields.bio = bio;

    if (req.file) {
      if (candidate.photoPublicId) {
        await deleteImage(candidate.photoPublicId).catch(() => null);
      }
      const { url, publicId } = await uploadCandidatePhoto(
        req.file.buffer,
        CLOUDINARY_FOLDERS.CANDIDATES,
        candidate._id.toString(),
      );
      updateFields.photoUrl = url;
      updateFields.photoPublicId = publicId;
    }

    const updated = await Candidate.findByIdAndUpdate(
      candidate._id,
      { $set: updateFields },
      { new: true, runValidators: true },
    );
    if (!updated) throw new AppError(404, "Candidate not found after update");

    sendSuccess(res, updated, "Candidate updated");
  },
);

export const deleteCandidate = asyncHandler(
  async (req: Request, res: Response) => {
    const candidate = await Candidate.findById(req.params.candidateId);
    if (!candidate) throw new AppError(404, "Candidate not found");

    const election = await Election.findById(candidate.electionId);
    if (!election) throw new AppError(404, "Election not found");

    const isAnon = election.electionMode === 'anonymous';
    const editBlocked = isAnon
      ? ['voting_open', 'voting_closed', 'results_published'].includes(election.status)
      : election.candidatesLocked;
    if (editBlocked) throw new AppError(409, 'Candidates cannot be modified at this stage');
    if (isAnon && election.status === 'paused') {
      logAction({ action: AUDIT_ACTIONS.CANDIDATE_EDITED_DURING_PAUSE, performedBy: req.user._id, targetId: election._id, targetModel: 'Election', metadata: { action: 'candidate_removed' } }).catch(() => null);
    }

    const voteExists = await Vote.findOne({ candidateId: candidate._id });
    if (voteExists)
      throw new AppError(409, "Cannot delete a candidate that has votes");

    const remainingCount = await Candidate.countDocuments({
      officeId: candidate.officeId,
    });
    if (remainingCount <= 1) {
      throw new AppError(409, "At least one candidate must remain per office");
    }

    if (candidate.photoPublicId) {
      await deleteImage(candidate.photoPublicId).catch(() => null);
    }
    await Candidate.findByIdAndDelete(candidate._id);

    await logAction({
      action: AUDIT_ACTIONS.CANDIDATE_REMOVED,
      performedBy: req.user._id,
      targetId: candidate._id,
      targetModel: "Candidate",
    });

    res.status(204).send();
  },
);
