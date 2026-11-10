import { createClient } from "redis";
import type { ConnectionOptions } from "bullmq";
import { env } from "./env";

const redisUrl = env.REDIS_PASSWORD
  ? `redis://:${encodeURIComponent(env.REDIS_PASSWORD)}@${env.REDIS_HOST}:${env.REDIS_PORT}`
  : `redis://${env.REDIS_HOST}:${env.REDIS_PORT}`;

export const redis = createClient({
  url: redisUrl,
  socket: {
    // Reconnect with capped exponential back-off
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("[redis] Too many reconnect attempts — giving up");
        return new Error("Redis reconnect limit reached");
      }
      return Math.min(retries * 100, 3000); // max 3 s between retries
    },
    connectTimeout: 5000,
  },
});

redis.on("error", (err) => console.error("[redis] client error:", err));
redis.on("connect", () => console.log("[redis] connected"));
redis.on("reconnecting", () => console.warn("[redis] reconnecting..."));

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

/**
 * Shared BullMQ connection options.
 *
 * All Queue and Worker instances must use this object instead of building
 * their own inline connection config.  Key points for Render's free Redis:
 *
 * - `enableOfflineQueue: false`  — BullMQ requirement; prevents commands from
 *   piling up in memory while Redis is unreachable.
 * - `maxRetriesPerRequest: null` — BullMQ requirement; lets it manage its own
 *   retry logic rather than ioredis timing out individual commands.
 * - `lazyConnect: true`          — suppresses the "IMPORTANT! Eviction policy"
 *   warning that BullMQ prints on startup when it cannot issue CONFIG SET.
 *   The connection is still made on first use; this just defers the check.
 *
 * We cannot change Render's free-tier eviction policy (volatile-lru) but
 * all application keys already use setEx/TTL, so they behave correctly under
 * volatile-lru.  BullMQ job metadata is the only risk; keeping removeOnComplete
 * and removeOnFail low (see queue defaultJobOptions) minimises that footprint.
 */
export const bullMQConnection: ConnectionOptions = {
  host:                 env.REDIS_HOST,
  port:                 parseInt(env.REDIS_PORT, 10),
  password:             env.REDIS_PASSWORD || undefined,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: null,
  lazyConnect:          true,
};