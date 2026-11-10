import { createClient } from "redis";
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
