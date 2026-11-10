import { Queue } from "bullmq";
import { bullMQConnection } from "../../config/redis";

export interface EmailJobData {
  to:      string;
  subject: string;
  html:    string;
  jobId:   string;
}

console.log(
  `[email-queue] Initializing queues | redis=${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
);

export const emailQueue = new Queue<EmailJobData>("email-main", {
  connection: bullMQConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail:     200,
  },
});

export const emailRetryQueue = new Queue<EmailJobData>("email-retry", {
  connection: bullMQConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail:     200,
  },
});

emailQueue.on("error", (err) =>
  console.error("[email-main queue] ❌ Queue error:", err.message)
);
emailRetryQueue.on("error", (err) =>
  console.error("[email-retry queue] ❌ Queue error:", err.message)
);

console.log("[email-queue] ✅ email-main and email-retry queues initialized");