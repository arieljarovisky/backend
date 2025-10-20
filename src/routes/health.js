import { Router } from "express";
export const health = Router();
health.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pelu-api", time: new Date().toISOString() });
});
