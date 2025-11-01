// src/routes/customersAdmin.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const customersAdmin = Router();
customersAdmin.use(requireAuth, requireRole("admin","user"));

/** Listado de clientes (con búsqueda y paginación opcional) */
customersAdmin.get("/", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const q = (req.query.q || "").trim();
    const search = `%${q}%`;

    const [rows] = await pool.query(
      `
      SELECT 
        c.id, 
        c.name, 
        c.phone_e164 AS phone,
        (
          SELECT COUNT(*) 
          FROM appointment a 
          WHERE a.customer_id = c.id 
            AND a.tenant_id = c.tenant_id
        ) AS total_appointments
      FROM customer c
      WHERE c.tenant_id = ?
        AND (c.name LIKE ? OR c.phone_e164 LIKE ?)
      ORDER BY c.name ASC
      LIMIT 50
      `,
      [tenantId, search, search]
    );

    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error("[CUSTOMERS] list error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Perfil del cliente con historial de turnos */
customersAdmin.get("/:id", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const id = Number(req.params.id);

    const [cust] = await pool.query(
      `SELECT id, name, phone_e164 AS phone 
         FROM customer 
        WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );
    if (!cust.length) {
      return res.status(404).json({ ok: false, error: "Cliente no encontrado" });
    }

    const [appts] = await pool.query(
      `
      SELECT 
        a.id, 
        a.starts_at, 
        a.ends_at, 
        a.status,
        s.name AS stylist, 
        sv.name AS service
      FROM appointment a
      JOIN stylist s  ON s.id  = a.stylist_id  AND s.tenant_id  = a.tenant_id
      JOIN service sv ON sv.id = a.service_id  AND sv.tenant_id = a.tenant_id
      WHERE a.customer_id = ?
        AND a.tenant_id   = ?
      ORDER BY a.starts_at DESC
      `,
      [id, tenantId]
    );

    res.json({
      ok: true,
      data: { ...cust[0], appointments: appts }
    });
  } catch (e) {
    console.error("[CUSTOMERS] detail error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
