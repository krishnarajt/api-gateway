import { Router } from "express";
import requireAuth from "../middleware/requireAuth.js";
import { fetchUserinfo } from "../services/oidc.js";

const r = Router();

r.get("/me", requireAuth, async (req, res) => {
  const { tokenSet } = req.auth;
  const userinfo = await fetchUserinfo(tokenSet.access_token);
  if (!userinfo) return res.status(502).json({ error: "Failed to fetch userinfo" });

  res.json({
    sub: userinfo.sub,
    name: userinfo.name || userinfo.preferred_username || null,
    email: userinfo.email || null,
    picture: userinfo.picture || null,
  });
});

export default r;
