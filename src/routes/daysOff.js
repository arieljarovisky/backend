// src/routes/daysOff.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const daysOff = Router();

// Seguridad: solo admin y staff
daysOff.use(requireAuth, requireRole("admin", "user"));

/**
 * GET /api/days-off?stylistId=&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
daysOff.get("/", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const stylistId = Number(req.query.stylistId);
    const from = req.query.from; // YYYY-MM-DD
    const to = req.query.to;     // YYYY-MM-DD

    if (!stylistId) {
      return res.status(400).json({ ok: false, error: "Falta el parámetro stylistId" });
    }

    // validar estilista del tenant
    const [[sty]] = await pool.query(
      "SELECT id FROM stylist WHERE id=? AND tenant_id=? LIMIT 1",
      [stylistId, tenantId]
    );
    if (!sty) return res.status(404).json({ ok:false, error:"Peluquero no encontrado en tu cuenta" });

    let sql = `
      SELECT id, stylist_id, starts_at, ends_at, reason, created_at
      FROM time_off
      WHERE tenant_id = ? AND stylist_id = ?
    `;
    const params = [tenantId, stylistId];

    if (from) { sql += " AND DATE(starts_at) >= ?"; params.push(from); }
    if (to)   { sql += " AND DATE(starts_at) <= ?"; params.push(to);   }

    sql += " ORDER BY starts_at ASC";

    const [rows] = await pool.query(sql, params);
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error("[GET /api/days-off] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Error al obtener días off" });
  }
});

/**
 * POST /api/days-off
 * Body: { stylistId, starts_at, ends_at, reason }
 */
daysOff.post("/", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { stylistId, starts_at, ends_at, reason } = req.body;

    if (!stylistId) {
      return res.status(400).json({ ok: false, error: "Falta stylistId" });
    }
    if (!starts_at || !ends_at) {
      return res.status(400).json({ ok: false, error: "Faltan starts_at y/o ends_at" });
    }

    // validar estilista
    const [[stylist]] = await pool.query(
      `SELECT id FROM stylist WHERE id = ? AND tenant_id=?`,
      [stylistId, tenantId]
    );
    if (!stylist) {
      return res.status(404).json({ ok: false, error: "Peluquero no encontrado en tu cuenta" });
    }

    // normalizar fechas ISO → MySQL
    const normalize = (dt) =>
      typeof dt === "string" && dt.includes("T")
        ? dt.replace("T", " ").slice(0, 19)
        : dt;

    const sAt = normalize(starts_at);
    const eAt = normalize(ends_at);

    if (new Date(eAt) <= new Date(sAt)) {
      return res.status(400).json({ ok: false, error: "La hora/fecha de fin debe ser posterior a la de inicio" });
    }

    // solapes
    const [overlaps] = await pool.query(
      `SELECT id FROM time_off
       WHERE tenant_id=? AND stylist_id = ?
         AND (starts_at < ? AND ends_at > ?)`,
      [tenantId, stylistId, eAt, sAt]
    );
    if (overlaps.length) {
      return res.status(400).json({ ok: false, error: "Ya existe un bloqueo en ese horario" });
    }

    const [result] = await pool.query(
      `INSERT INTO time_off (tenant_id, stylist_id, starts_at, ends_at, reason, created_at)
       VALUES (?,?,?,?,?, NOW())`,
      [tenantId, stylistId, sAt, eAt, reason || "Bloqueo de tiempo"]
    );

    return res.json({ ok: true, id: result.insertId, message: "Bloqueo creado" });
  } catch (e) {
    console.error("[POST /api/days-off] error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Error al crear bloqueo" });
  }
});

/**
 * PUT /api/days-off/:id
 */
daysOff.put("/:id", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok:false, error:"ID inválido" });

    const { starts_at, ends_at, reason } = req.body;

    const [[block]] = await pool.query(
      `SELECT * FROM time_off WHERE id = ? AND tenant_id=?`,
      [id, tenantId]
    );
    if (!block) return res.status(404).json({ ok:false, error:"Bloqueo no encontrado" });

    const normalize = (dt) =>
      typeof dt === "string" && dt.includes("T")
        ? dt.replace("T", " ").slice(0, 19)
        : dt;

    const sAt = starts_at ? normalize(starts_at) : block.starts_at;
    const eAt = ends_at   ? normalize(ends_at)   : block.ends_at;

    if (new Date(eAt) <= new Date(sAt)) {
      return res.status(400).json({ ok:false, error:"La hora/fecha de fin debe ser posterior a la de inicio" });
    }

    await pool.query(
      `UPDATE time_off 
          SET starts_at=?, ends_at=?, reason=? 
        WHERE id=? AND tenant_id=?`,
      [sAt, eAt, reason ?? block.reason, id, tenantId]
    );

    return res.json({ ok:true, message:"Bloqueo actualizado" });
  } catch (e) {
    console.error("[PUT /api/days-off/:id] error:", e);
    return res.status(500).json({ ok:false, error:e.message || "Error al actualizar bloqueo" });
  }
});

/**
 * DELETE /api/days-off/:id
 */
daysOff.delete("/:id", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok:false, error:"ID inválido" });

    const [r] = await pool.query(
      `DELETE FROM time_off WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );

    if (!r.affectedRows) {
      return res.status(404).json({ ok:false, error:"Bloqueo no encontrado" });
    }
    return res.json({ ok:true, message:"Bloqueo eliminado" });
  } catch (e) {
    console.error("[DELETE /api/days-off/:id] error:", e);
    return res.status(500).json({ ok:false, error:e.message || "Error al eliminar bloqueo" });
  }
});
