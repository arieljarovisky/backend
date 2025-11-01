// src/routes/meta.js — MULTI-TENANT (listas para combos/selector)
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const meta = Router();
meta.use(requireAuth, requireRole("admin","user"));

/**
 * GET /api/meta/stylists?active=1
 * Lista estilistas del tenant (para selects)
 */
meta.get("/meta/stylists", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const onlyActive = String(req.query.active || "1") === "1";

    const [rows] = await pool.query(
      `
      SELECT id, name, user_id, is_active
      FROM stylist
      WHERE tenant_id = ?
        ${onlyActive ? "AND is_active = 1" : ""}
      ORDER BY name ASC
      `,
      [tenantId]
    );

    res.json({ ok:true, data: rows });
  } catch (e) {
    console.error("[GET /meta/stylists] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * GET /api/meta/services?active=1
 * Lista servicios del tenant (para selects)
 */
meta.get("/meta/services", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const onlyActive = String(req.query.active || "1") === "1";

    const [rows] = await pool.query(
      `
      SELECT id, name, price_decimal, duration_min, is_active
      FROM service
      WHERE tenant_id = ?
        ${onlyActive ? "AND is_active = 1" : ""}
      ORDER BY name ASC
      `,
      [tenantId]
    );

    res.json({ ok:true, data: rows });
  } catch (e) {
    console.error("[GET /meta/services] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * GET /api/meta/customers?q=texto
 * Búsqueda rápida de clientes por nombre/teléfono
 */
meta.get("/meta/customers", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const q = (req.query.q || "").trim();
    const like = `%${q}%`;

    const [rows] = await pool.query(
      `
      SELECT id, name, phone_e164 AS phone
      FROM customer
      WHERE tenant_id = ?
        AND (name LIKE ? OR phone_e164 LIKE ?)
      ORDER BY name ASC
      LIMIT 50
      `,
      [tenantId, like, like]
    );

    res.json({ ok:true, data: rows });
  } catch (e) {
    console.error("[GET /meta/customers] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * GET /api/meta/appointment-status
 * Lista fija de estados (por si querés poblar un select)
 */
meta.get("/meta/appointment-status", async (_req, res) => {
  res.json({
    ok: true,
    data: [
      "scheduled",
      "pending_deposit",
      "deposit_paid",
      "confirmed",
      "completed",
      "cancelled",
      "no_show"
    ]
  });
});
