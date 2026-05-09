import { Router } from "express";
import config from "../config/index.js";
import requireAuth from "../middleware/requireAuth.js";
import { getSession } from "../services/sessionStore.js";
import { createApiProxy } from "../services/proxy.js";

const r = Router();
const apiProxy = createApiProxy();

function isPublicMobileAuthStart(req) {
  return /^\/[a-z0-9_-]+\/mobile\/auth\/start(?:\/)?$/i.test(req.path);
}

async function ensureMobileAuthBrowserSession(req, res, next) {
  if (!isPublicMobileAuthStart(req)) {
    return requireAuth(req, res, next);
  }

  const sid = req.cookies?.[config.cookie.name];
  const session = await getSession(sid);
  if (session?.access_token) {
    return requireAuth(req, res, next);
  }

  const frontendHost = config.baseUrl;
  const loginUrl = new URL("/auth/login", config.baseUrl);
  loginUrl.searchParams.set("frontend_host", frontendHost);
  loginUrl.searchParams.set("next", req.originalUrl || req.url || "/");
  return res.redirect(loginUrl.toString());
}

r.use("/", ensureMobileAuthBrowserSession, apiProxy);

export { apiProxy };
export default r;
