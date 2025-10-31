// src/routes/daysOff.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const daysOff = Router();

// Seguridad: solo admin y staff pueden gestionar bloqueos
daysOff.use(requireAuth, requireRole("admin", "user"));

/**
 * GET /api/days-off
 * Lista los días/horarios bloqueados de un peluquero
 * Query params:
 *   - stylistId (requerido)
 *   - from (opcional, YYYY-MM-DD)
 *   - to (opcional, YYYY-MM-DD)
 */
daysOff.get("/", async (req, res) => {
  try {
    const stylistId = Number(req.query.stylistId);
    const from = req.query.from; // YYYY-MM-DD
    const to = req.query.to;     // YYYY-MM-DD

    if (!stylistId) {
      return res.status(400).json({ 
        ok: false, 
        error: "Falta el parámetro stylistId" 
      });
    }

    let query = `
      SELECT 
        id,
        stylist_id,
        starts_at,
        ends_at,
        reason,
        created_at
      FROM time_off
      WHERE stylist_id = ?
    `;
    const params = [stylistId];

    // Filtrar por rango de fechas si se proporciona
    if (from) {
      query += ` AND DATE(starts_at) >= ?`;
      params.push(from);
    }
    if (to) {
      query += ` AND DATE(starts_at) <= ?`;
      params.push(to);
    }

    query += ` ORDER BY starts_at ASC`;

    const [rows] = await pool.query(query, params);

    return res.json({ 
      ok: true, 
      data: rows 
    });
  } catch (e) {
    console.error("[GET /api/days-off] error:", e);
    return res.status(500).json({ 
      ok: false, 
      error: e.message || "Error al obtener días off" 
    });
  }
});

/**
 * POST /api/days-off
 * Crea un nuevo bloqueo de tiempo
 * Body:
 *   - stylistId (requerido)
 *   - starts_at (requerido, ISO datetime o "YYYY-MM-DD HH:MM:SS")
 *   - ends_at (requerido, ISO datetime o "YYYY-MM-DD HH:MM:SS")
 *   - reason (opcional)
 */
daysOff.post("/", async (req, res) => {
  try {
    const { stylistId, starts_at, ends_at, reason } = req.body;

    // Validaciones básicas
    if (!stylistId) {
      return res.status(400).json({ 
        ok: false, 
        error: "Falta stylistId" 
      });
    }
    if (!starts_at || !ends_at) {
      return res.status(400).json({ 
        ok: false, 
        error: "Faltan starts_at y/o ends_at" 
      });
    }

    // Validar que el peluquero existe
    const [[stylist]] = await pool.query(
      `SELECT id FROM stylist WHERE id = ?`,
      [stylistId]
    );
    if (!stylist) {
      return res.status(404).json({ 
        ok: false, 
        error: "Peluquero no encontrado" 
      });
    }

    // Convertir fechas a formato MySQL si vienen en ISO
    const normalizeDateTime = (dt) => {
      if (!dt) return null;
      // Si viene como "YYYY-MM-DDTHH:MM:SS" o "YYYY-MM-DDTHH:MM:SS.sssZ"
      if (typeof dt === 'string' && dt.includes('T')) {
        return dt.replace('T', ' ').slice(0, 19);
      }
      return dt;
    };

    const startsAtNormalized = normalizeDateTime(starts_at);
    const endsAtNormalized = normalizeDateTime(ends_at);

    // Validar que end sea posterior a start
    if (new Date(endsAtNormalized) <= new Date(startsAtNormalized)) {
      return res.status(400).json({ 
        ok: false, 
        error: "La hora/fecha de fin debe ser posterior a la de inicio" 
      });
    }

    // Verificar solapamientos con bloqueos existentes
    const [overlaps] = await pool.query(
      `SELECT id FROM time_off
       WHERE stylist_id = ?
         AND (
           (starts_at < ? AND ends_at > ?)
           OR (starts_at < ? AND ends_at > ?)
           OR (starts_at >= ? AND ends_at <= ?)
         )`,
      [
        stylistId,
        endsAtNormalized, startsAtNormalized,  // nuevo empieza antes del fin de existente
        endsAtNormalized, startsAtNormalized,  // nuevo termina después del inicio de existente
        startsAtNormalized, endsAtNormalized   // nuevo está completamente dentro de existente
      ]
    );

    if (overlaps.length > 0) {
      return res.status(400).json({ 
        ok: false, 
        error: "Ya existe un bloqueo en ese horario" 
      });
    }

    // Insertar el bloqueo
    const [result] = await pool.query(
      `INSERT INTO time_off (stylist_id, starts_at, ends_at, reason, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [
        stylistId,
        startsAtNormalized,
        endsAtNormalized,
        reason || "Bloqueo de tiempo"
      ]
    );

    return res.json({ 
      ok: true, 
      id: result.insertId,
      message: "Bloqueo creado exitosamente" 
    });
  } catch (e) {
    console.error("[POST /api/days-off] error:", e);
    return res.status(500).json({ 
      ok: false, 
      error: e.message || "Error al crear bloqueo" 
    });
  }
});

/**
 * DELETE /api/days-off/:id
 * Elimina un bloqueo de tiempo
 */
daysOff.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ 
        ok: false, 
        error: "ID inválido" 
      });
    }

    // Verificar que existe
    const [[block]] = await pool.query(
      `SELECT id FROM time_off WHERE id = ?`,
      [id]
    );

    if (!block) {
      return res.status(404).json({ 
        ok: false, 
        error: "Bloqueo no encontrado" 
      });
    }

    // Eliminar
    await pool.query(
      `DELETE FROM time_off WHERE id = ?`,
      [id]
    );

    return res.json({ 
      ok: true,
      message: "Bloqueo eliminado exitosamente" 
    });
  } catch (e) {
    console.error("[DELETE /api/days-off/:id] error:", e);
    return res.status(500).json({ 
      ok: false, 
      error: e.message || "Error al eliminar bloqueo" 
    });
  }
});

/**
 * PUT /api/days-off/:id
 * Actualiza un bloqueo existente (opcional, por si querés editar)
 */
daysOff.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { starts_at, ends_at, reason } = req.body;

    if (!id) {
      return res.status(400).json({ 
        ok: false, 
        error: "ID inválido" 
      });
    }

    // Verificar que existe
    const [[block]] = await pool.query(
      `SELECT * FROM time_off WHERE id = ?`,
      [id]
    );

    if (!block) {
      return res.status(404).json({ 
        ok: false, 
        error: "Bloqueo no encontrado" 
      });
    }

    // Normalizar fechas
    const normalizeDateTime = (dt) => {
      if (!dt) return null;
      if (typeof dt === 'string' && dt.includes('T')) {
        return dt.replace('T', ' ').slice(0, 19);
      }
      return dt;
    };

    const updates = {};
    if (starts_at) updates.starts_at = normalizeDateTime(starts_at);
    if (ends_at) updates.ends_at = normalizeDateTime(ends_at);
    if (reason !== undefined) updates.reason = reason;

    // Validar que end > start si se actualizan ambos
    const finalStart = updates.starts_at || block.starts_at;
    const finalEnd = updates.ends_at || block.ends_at;

    if (new Date(finalEnd) <= new Date(finalStart)) {
      return res.status(400).json({ 
        ok: false, 
        error: "La hora/fecha de fin debe ser posterior a la de inicio" 
      });
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ 
        ok: true, 
        message: "Nada que actualizar" 
      });
    }

    // Construir query dinámicamente
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), id];

    await pool.query(
      `UPDATE time_off SET ${fields} WHERE id = ?`,
      values
    );

    return res.json({ 
      ok: true,
      message: "Bloqueo actualizado exitosamente" 
    });
  } catch (e) {
    console.error("[PUT /api/days-off/:id] error:", e);
    return res.status(500).json({ 
      ok: false, 
      error: e.message || "Error al actualizar bloqueo" 
    });
  }
});