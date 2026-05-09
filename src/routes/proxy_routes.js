import { Router } from "express";
import requireAuth from "../middleware/requireAuth.js";
import { createApiProxy } from "../services/proxy.js";

const r = Router();
const apiProxy = createApiProxy();

function isPublicMobileAuthStart(req) {
  return /^\/[a-z0-9_-]+\/mobile\/auth\/start(?:\/)?$/i.test(req.path);
}

r.use("/", (req, res, next) => {
  if (isPublicMobileAuthStart(req)) return next();
  return requireAuth(req, res, next);
}, apiProxy);

export { apiProxy };
export default r;
