import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Election from '../models/Election';
import Office from '../models/Office';
import { AppError } from '../utils/AppError';

export async function authorizeElection(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let electionId: string | undefined = req.params.id ?? req.params.electionId;

    if (!electionId && req.params.officeId) {
      if (!mongoose.Types.ObjectId.isValid(req.params.officeId)) {
        return next(new AppError(400, 'Invalid office ID'));
      }
      const office = await Office.findById(req.params.officeId);
      if (!office) return next(new AppError(404, 'Office not found'));
      electionId = office.electionId.toString();
    }

    if (!electionId) return next(new AppError(400, 'Election ID could not be determined'));
    if (!mongoose.Types.ObjectId.isValid(electionId)) {
      return next(new AppError(400, 'Invalid election ID'));
    }

    const election = await Election.findById(electionId);
    if (!election) return next(new AppError(404, 'Election not found'));

    const user = req.user;
    const isSuperAdmin = user.role === 'super_admin';
    const isAssignedOfficer =
      user.role === 'officer' &&
      election.assignedOfficerId != null &&
      election.assignedOfficerId.toString() === user._id.toString();

    const isPublicCreatorOwner =
      user.role === 'public_creator' &&
      election.createdByPublic != null &&
      election.createdByPublic.toString() === user._id.toString();

    if (!isSuperAdmin && !isAssignedOfficer && !isPublicCreatorOwner) {
      return next(new AppError(403, 'You are not authorized for this election'));
    }

    if (!isSuperAdmin && election.isLocked) {
      return next(new AppError(423, 'Election is in lockdown'));
    }

    req.election = election;
    next();
  } catch (err) {
    next(err);
  }
}
