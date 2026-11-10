/**
 * Integrity check queue — BullMQ Queue + typed job data.
 *
 * Shared by:
 *   • voting.controller.ts  (enqueues the job)
 *   • integrityCheck.worker.ts (processes it)
 *
 * One queue, one job type. Keeping it separate from the email queue so
 * email throughput and integrity jobs never compete for the same concurrency slot.
 */
import { Queue } from "bullmq";
import { bullMQConnection } from "../config/redis";

export interface IntegrityCheckJobData {
  electionId:  string;
  requestedBy: string; // userId of the SA who triggered it
}

export interface IntegrityCheckJobResult {
  totalVotes:  number;
  intact:      number;
  tampered:    number;
  tamperedIds: string[];
}

export const integrityCheckQueue = new Queue<
  IntegrityCheckJobData,
  IntegrityCheckJobResult
>("integrity-check", {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff:  { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 50 }, // keep last 50 completed jobs for audit
    removeOnFail:     { count: 50 },
  },
});