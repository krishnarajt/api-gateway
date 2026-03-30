import { createServer } from "http";
import cookie from "cookie";
import app from "./app.js";
import config from "./config/index.js";
import logger from "./utils/logger.js";
import { getMappings, getDefaultBackend } from "./config/proxyConfig.js";
import { startHealthChecker } from "./services/healthChecker.js";
import { getSession } from "./services/sessionStore.js";
import { apiProxy } from "./routes/proxy_routes.js";

const server = createServer(app);

// Handle WebSocket upgrades for /api/* paths
server.on("upgrade", async (req, socket, head) => {
	try {
		// Only handle /api/* WebSocket upgrades
		if (!req.url?.startsWith("/api")) {
			socket.destroy();
			return;
		}

		// Parse session cookie for authentication
		const cookies = cookie.parse(req.headers.cookie || "");
		const sid = cookies[config.cookie.name];
		const sess = await getSession(sid);

		if (!sess?.access_token) {
			logger.warn("WebSocket upgrade rejected: no valid session");
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}

		// Strip client-provided user headers and inject trusted ones
		delete req.headers["x-user-email"];
		delete req.headers["x-user-sub"];
		delete req.headers["x-user-name"];

		if (sess.user) {
			if (sess.user.email) req.headers["x-user-email"] = sess.user.email;
			if (sess.user.sub) req.headers["x-user-sub"] = sess.user.sub;
			if (sess.user.name) req.headers["x-user-name"] = sess.user.name;
		}

		// Rewrite /api/<name> prefix from the URL (same as HTTP proxy)
		req.url = req.url.replace(/^\/api\/[a-z0-9_-]+/i, "") || "/";

		// Forward the upgrade to the proxy
		apiProxy.upgrade(req, socket, head);
	} catch (err) {
		logger.error({ err }, "WebSocket upgrade error");
		socket.destroy();
	}
});

server.listen(config.port, () => {
	logger.info({ port: config.port }, "BFF listening");

	// Start backend health checks after server is up
	startHealthChecker(getMappings(), getDefaultBackend());
});

process.on("unhandledRejection", (err) => {
	logger.error({ err }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
	logger.error({ err }, "uncaughtException");
	process.exit(1);
});
