import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import User, { IUser } from '../models/User';
import { getCachedUser, setCachedUser, CachedUser } from '../services/userCache.service';

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    console.log(`[AUTH] ${req.method} ${req.path} — Authorization header present: ${!!authHeader}`);

    if (!authHeader?.startsWith('Bearer ')) {
      console.log('[AUTH] No Bearer token — rejecting with 401');
      return next(new AppError(401, 'No token provided'));
    }

    const token = authHeader.split(' ')[1];
    console.log(`[AUTH] Token received (first 20 chars): ${token.slice(0, 20)}...`);

    // Only userId in payload — role is always read live (from cache or DB)
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string };
    console.log(`[AUTH] Token verified — userId: ${payload.userId}`);

    // 1. Try Redis cache first
    let user: IUser | CachedUser | null = await getCachedUser(payload.userId);

    if (!user) {
      console.log(`[AUTH] User not in cache — querying DB for userId: ${payload.userId}`);
      const dbUser = await User.findById(payload.userId).lean<IUser>();
      if (!dbUser) {
        console.log('[AUTH] User not found in DB — rejecting with 401');
        return next(new AppError(401, 'User not found'));
      }
      await setCachedUser(dbUser);
      user = dbUser;
    } else {
      console.log(`[AUTH] User loaded from cache`);
    }

    console.log(`[AUTH] User resolved — id: ${user._id}, role: ${user.role}, isActive: ${user.isActive}`);

    if (!user.isActive)   return next(new AppError(403, 'Account deactivated'));
    if (user.isSuspended) return next(new AppError(403, 'Account suspended'));

    // Redis stores the user as JSON, so _id is deserialised as a plain string.
    // Mongoose queries that compare against ObjectId fields (e.g. createdByPublic)
    // silently return no results when given a string instead of an ObjectId.
    // Coerce here once so every downstream handler always has a real ObjectId.
    const rawId = (user._id as Types.ObjectId | string).toString();
    (user as IUser)._id = Types.ObjectId.createFromHexString(rawId);

    // passwordHash is stripped in CachedUser — cast is safe because all
    // fields required by downstream handlers are present on both types.
    req.user = user as IUser;
    next();
  } catch (err) {
    console.log('[AUTH] Token verification failed:', err instanceof Error ? err.message : err);
    if (err instanceof AppError) return next(err);
    next(new AppError(401, 'Invalid or expired token'));
  }
}