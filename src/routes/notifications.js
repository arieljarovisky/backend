// src/routes/notifications.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireRole } from "../auth/middlewares.js";

export const notifications = Router();

/** LISTAR (usa auth del router montado en index.js) */
notifications.get("/notifications", async (req, res) => {
  try {
    const { unreadOnly } = req.query;
    const userId = req.user.id;
    const sql = `
      SELECT id, user_id, type, title, message, data, is_read, created_at
      FROM notifications
      WHERE user_id = ?
      ${unreadOnly === "true" ? "AND is_read = 0" : ""}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const [rows] = await pool.query(sql, [userId]);
    res.json({
      ok: true,
      data: rows.map(r => ({ ...r, data: r.data ? safeParseJSON(r.data) : null })),
    });
  } catch (error) {
    console.error("❌ [GET /notifications] Error:", error);
    res.status(500).json({ error: "Error al obtener notificaciones" });
  }
});

/** CONTAR (con logs para ver que corre) */
notifications.get("/notifications/count", async (req, res) => {
  try {
    console.log("📫 [/notifications/count] userId:", req.user?.id);
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
      [req.user.id]
    );
    console.log("📫 [/notifications/count] rows:", rows);
    res.json({ ok: true, count: rows[0]?.count || 0 });
  } catch (error) {
    console.error("❌ [/notifications/count] Error:", error.code, error.sqlMessage || error.message);
    res.status(500).json({ error: "Error al contar notificaciones" });
  }
});

/** MARCAR LEÍDA */
notifications.put("/notifications/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("❌ [PUT /notifications/:id/read] Error:", error);
    res.status(500).json({ error: "Error al marcar notificación" });
  }
});

/** MARCAR TODAS LEÍDAS */
notifications.put("/notifications/read-all", async (req, res) => {
  try {
    await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("❌ [PUT /notifications/read-all] Error:", error);
    res.status(500).json({ error: "Error al marcar notificaciones" });
  }
});

/** BORRAR */
notifications.delete("/notifications/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "DELETE FROM notifications WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("❌ [DELETE /notifications/:id] Error:", error);
    res.status(500).json({ error: "Error al eliminar notificación" });
  }
});

/** CREAR (endpoint real) */
notifications.post("/notifications", async (req, res) => {
  try {
    const { userId, type, title, message, data = null } = req.body;
    const targetUserId = userId || req.user.id;
    console.log("📝 [/notifications] create payload:", { targetUserId, type, title });

    const [result] = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, is_read)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [targetUserId, type, title, message, data ? JSON.stringify(data) : null]
    );
    console.log("📝 [/notifications] insertId:", result?.insertId);
    res.json({ ok: true, id: result?.insertId ?? null });
  } catch (error) {
    console.error("❌ [/notifications] create Error:", error.code, error.sqlMessage || error.message);
    res.status(500).json({ ok: false, error: "Error al crear notificación" });
  }
});

function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

// Helper (lo dejás igual)
export async function createNotification({ userId, type, title, message, data = null }) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, is_read)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [userId, type, title, message, data ? JSON.stringify(data) : null]
    );
  } catch (error) {
    console.error("❌ [createNotification] Error:", error);
  }
}
