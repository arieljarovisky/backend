// src/routes/notifications.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const notifications = Router();

// GET /api/notifications
notifications.get("/notifications", requireAuth, async (req, res) => {
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
      data: rows.map(r => ({
        ...r,
        data: r.data ? safeParseJSON(r.data) : null,
      })),
    });
  } catch (error) {
    console.error("❌ [GET /notifications] Error:", error);
    res.status(500).json({ error: "Error al obtener notificaciones" });
  }
});

// GET /api/notifications/count
notifications.get("/notifications/count", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
      [req.user.id]
    );
    res.json({ ok: true, count: rows[0]?.count || 0 });
  } catch (error) {
    console.error("❌ [GET /notifications/count] Error:", error);
    res.status(500).json({ error: "Error al contar notificaciones" });
  }
});

// PUT /api/notifications/:id/read
notifications.put("/notifications/:id/read", requireAuth, async (req, res) => {
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

// PUT /api/notifications/read-all
notifications.put("/notifications/read-all", requireAuth, async (req, res) => {
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

// DELETE /api/notifications/:id
notifications.delete("/notifications/:id", requireAuth, async (req, res) => {
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

// POST /api/notifications/test (solo admin)
notifications.post("/notifications/test", requireRole("admin"), async (req, res) => {
  try {
    const { userId, type, title, message, data = null } = req.body;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, is_read)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [userId, type, title, message, data ? JSON.stringify(data) : null]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("❌ [POST /notifications/test] Error:", error);
    res.status(500).json({ error: "Error al crear notificación" });
  }
});

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Si querés exponer helpers:
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

export async function notifyAdmins({ type, title, message, data = null }) {
  try {
    const [admins] = await pool.query(
      'SELECT id FROM users WHERE role IN ("admin", "user")'
    );
    for (const admin of admins) {
      await createNotification({ userId: admin.id, type, title, message, data });
    }
  } catch (error) {
    console.error("❌ [notifyAdmins] Error:", error);
  }
}
