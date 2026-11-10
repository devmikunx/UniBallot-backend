import "./config/cloudinary";
import mongoose from "mongoose";
import morgan from "morgan";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env";
import { redis } from "./config/redis";
import { generalLimiter } from "./middleware/rateLimiter";
import { errorHandler, notFound } from "./middleware/errorHandler";

import authRoutes from "./routes/auth.routes";
import userRoutes from "./routes/user.routes";
import superAdminRoutes from "./routes/superAdmin.routes";
import associationRoutes from "./routes/association.routes";
import electionRoutes from "./routes/election.routes";
import candidateRoutes from "./routes/candidate.routes";
import emaildashboardRoutes from "./routes/Emaildashboard.routes";
import webhookRoutes from "./routes/Webhook.routes";
import anonRoutes from "./routes/anon.routes";

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "https://res.cloudinary.com"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
  }),
);
app.disable("x-powered-by");

const allowedOrigins = env.FRONTEND_ORIGIN.split(",").map((o) => o.trim());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

app.use(generalLimiter);

app.get("/health", async (_req, res) => {
  const dbOk    = mongoose.connection.readyState === 1;
  const redisOk = redis.isOpen;
  const status  = dbOk && redisOk ? 'ok' : 'degraded';

  return res.status(dbOk && redisOk ? 200 : 503).json({
    status,
    uptime:    process.uptime(),
    memory:    process.memoryUsage(),
    db:        dbOk    ? 'connected'    : 'disconnected',
    redis:     redisOk ? 'connected'    : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/api/associations", associationRoutes);
app.use("/api/elections", electionRoutes);
app.use("/api/offices", candidateRoutes);
app.use("/api/email/dashboard", emaildashboardRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/anon", anonRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
