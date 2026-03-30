import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import config from "./config/index.js";
import { getAllowedOrigins } from "./config/proxyConfig.js";
import logger from "./utils/logger.js";
import authRoutes from "./routes/auth.js";
import apiRoutes from "./routes/api.js";
import healthRoutes from "./routes/health.js";
import adminRoutes from "./routes/admin.js";
import proxyRoutes from "./routes/proxy_routes.js";

const app = express();
app.set("trust proxy", 1);

// security headers
app.use(
	helmet({
		crossOriginOpenerPolicy: { policy: "same-origin" },
		crossOriginResourcePolicy: { policy: "same-site" },
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
				connectSrc: ["'self'", "https://cloudflareinsights.com"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				imgSrc: ["'self'", "data:"],
			},
		},
	})
);

// logging
app.use(pinoHttp({ logger }));
if (config.nodeEnv === "development") app.use(morgan("dev"));

// CORS — driven by config.yml allowedOrigins + ALLOWED_ORIGINS env
app.use(
	cors({
		origin: (origin, callback) => {
			// Allow requests with no Origin header (curl, server-to-server, same-origin navigation)
			if (!origin) return callback(null, true);
			if (getAllowedOrigins().includes(origin)) return callback(null, true);
			callback(new Error("Not allowed by CORS"));
		},
		credentials: true,
		methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
	})
);

// Mount proxy BEFORE body parsers so request bodies are streamed untouched
app.use(cookieParser());
app.use("/api", proxyRoutes);

// body parsers — everything after proxy
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

// rate limit on auth endpoints
const authLimiter = rateLimit({
	windowMs: 60_000,
	max: 60,
	standardHeaders: true,
	legacyHeaders: false,
});
app.use("/auth/", authLimiter);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(
	express.static(path.join(__dirname, "..", "public"), {
		index: "index.html",
		extensions: ["html"],
	})
);

// routes
app.use("/auth", authRoutes);
app.use("/whoami", apiRoutes);
app.use("/admin", adminRoutes);
app.use(healthRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not Found" }));

// error handler
app.use((err, req, res, _next) => {
	req.log?.error({ err }, "Unhandled error");
	res.status(err.status || 500).json({ error: "Internal Server Error" });
});

export default app;
