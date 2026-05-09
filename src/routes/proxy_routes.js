import { Router } from "express";
import requireAuth from "../middleware/requireAuth.js";
import { createApiProxy } from "../services/proxy.js";

const r = Router();
const apiProxy = createApiProxy();

// Mobile auth bootstrap endpoints must be reachable before a session exists.
r.use("/:app/mobile/auth/start", apiProxy);
r.use("/", requireAuth, apiProxy);

export { apiProxy };
export default r;
