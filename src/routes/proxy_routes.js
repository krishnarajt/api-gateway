import { Router } from "express";
import requireAuth from "../middleware/requireAuth.js";
import { createApiProxy } from "../services/proxy.js";

const r = Router();
const apiProxy = createApiProxy();

r.use("/", requireAuth, apiProxy);

export { apiProxy };
export default r;
