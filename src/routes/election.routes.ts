import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/authenticate";
import { authorize } from "../middleware/authorize";
import { authorizeElection } from "../middleware/authorizeElection";
import { validate } from "../middleware/validate";
import { uploadCsv } from "../middleware/upload";
import {
  votingLimiter,
  receiptLimiter,
  codeLookupLimiter,
  publicElectionLimiter,
} from "../middleware/rateLimiter";

import {
  createElection,
  createElectionSchema,
  listElections,
  getElection,
  getElectionByCode,
  updateElection,
  deleteElection,
  transitionStatus,
  toggleLockdown,
  registerForElection,
  getAnalytics,
  publishResults,
  getResults,
  previewResults,
  getResultsByCode,
  listMyElections,
  getOpenElections,
  exportResultsCsv,
  exportResultsPdf,
  togglePublicResults,
  listCreatorElections,
} from "../controllers/election.controller";

import {
  uploadMembers,
  listMembers,
  clearMembers,
  getMember,
  updateMember,
  deleteMember,
  getMemberCount,
} from "../controllers/member.controller";

import {
  createOffice,
  officeSchema,
  listOffices,
  updateOffice,
  deleteOffice,
} from "../controllers/office.controller";

import {
  getBallotHandler,
  submitBallotHandler,
  verifyReceipt,
  integrityCheck,
  getIntegrityResult,
  voteSubmissionSchema,
} from "../controllers/voting.controller";
import { concurrencyLimit } from "../middleware/concurrencyLimit";

const router = Router();

const statusTransitionLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req) => `${req.user?._id ?? req.ip}:${req.params.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many status transitions, please try again later",
  },
  statusCode: 429,
});

router.get("/code/:code", codeLookupLimiter, getElectionByCode);
router.get(
  "/code/:code/results",
  authenticate,
  authorize("super_admin", "student"),
  getResultsByCode,
);

router.post(
  "/register",
  authenticate,
  authorize("student"),
  validate(z.object({ electionCode: z.string().min(1) })),
  registerForElection,
);

router.post(
  "/",
  authenticate,
  authorize("super_admin", "public_creator"),
  validate(createElectionSchema),
  createElection,
);
router.get(
  "/",
  authenticate,
  authorize("super_admin", "officer"),
  listElections,
);
router.get("/open", publicElectionLimiter, getOpenElections);
router.get("/my", authenticate, authorize("student"), listMyElections);
router.get("/my-created", authenticate, authorize("public_creator"), listCreatorElections);

router.get("/:id/receipt/:code", receiptLimiter, verifyReceipt);

router.get("/:id", authenticate, authorizeElection, getElection);
router.patch("/:id", authenticate, authorize("super_admin"), updateElection);
router.delete(
  "/:id",
  authenticate,
  authorize("super_admin"),
  validate(z.object({ force: z.boolean().optional() })),
  deleteElection,
);

router.patch(
  "/:id/status",
  authenticate,
  authorizeElection,
  statusTransitionLimiter,
  validate(z.object({ status: z.string().min(1) })),
  transitionStatus,
);
router.post(
  "/:id/lockdown",
  authenticate,
  authorize("super_admin"),
  validate(z.object({ active: z.boolean() })),
  toggleLockdown,
);

router.post(
  "/:id/members",
  authenticate,
  authorizeElection,
  uploadCsv,
  uploadMembers,
);

router.get("/:id/members", authenticate, authorizeElection, listMembers);

router.delete(
  "/:id/members",
  authenticate,
  authorize("super_admin"),
  clearMembers,
);

router.get(
  "/:id/members/count",
  authenticate,
  authorizeElection,
  getMemberCount,
);

router.get(
  "/:id/members/:memberId",
  authenticate,
  authorizeElection,
  getMember,
);
router.patch(
  "/:id/members/:memberId",
  authenticate,
  authorizeElection,
  updateMember,
);
router.delete(
  "/:id/members/:memberId",
  authenticate,
  authorizeElection,
  deleteMember,
);

router.post(
  "/:id/offices",
  authenticate,
  authorizeElection,
  validate(officeSchema),
  createOffice,
);
router.get("/:id/offices", authenticate, authorizeElection, listOffices);
router.patch(
  "/:id/offices/:officeId",
  authenticate,
  authorizeElection,
  updateOffice,
);
router.delete(
  "/:id/offices/:officeId",
  authenticate,
  authorizeElection,
  deleteOffice,
);

router.get("/:id/ballot", authenticate, authorize("student"), getBallotHandler);
router.post(
  "/:id/vote",
  authenticate,
  authorize("student"),
  concurrencyLimit,
  votingLimiter,
  validate(voteSubmissionSchema),
  submitBallotHandler,
);

router.get(
  "/:id/results/preview",
  authenticate,
  authorizeElection,
  previewResults,
);
router.get(
  "/:id/results",
  authenticate,
  authorize("super_admin", "student", "public_creator"),
  getResults,
);
router.post(
  "/:id/publish-results",
  authenticate,
  authorizeElection,
  publishResults,
);

router.get("/:id/analytics", authenticate, authorizeElection, getAnalytics);
router.get(
  "/:id/integrity-check",
  authenticate,
  authorize("super_admin"),
  integrityCheck,
);
router.get(
  "/:id/integrity-result/:jobId",
  authenticate,
  authorize("super_admin"),
  getIntegrityResult,
);

router.get(
  "/:id/export/csv",
  authenticate,
  authorize("super_admin", "officer"),
  exportResultsCsv,
);
router.get(
  "/:id/export/pdf",
  authenticate,
  authorize("super_admin", "officer"),
  exportResultsPdf,
);

router.patch("/:id/public-results", authenticate, authorizeElection, validate(z.object({ enable: z.boolean() })), togglePublicResults);

export default router;