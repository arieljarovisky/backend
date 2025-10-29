// src/routes/depositsAdmin.js - API completa para gestión de depósitos
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const depositsAdmin = Router();
depositsAdmin.use(requireAuth, requireRole("admin", "staff"));

// ============================================
// DASHBOARD - Métricas principales
// ============================================
depositsAdmin.get("/dashboard", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    
    try {
      // Stats generales
      const [[stats]] = await conn.query(`
        SELECT
          SUM(CASE 
            WHEN status = 'pending_deposit' 
            AND hold_until > NOW() 
            THEN 1 ELSE 0 
          END) AS pendingActive,
          
          SUM(CASE 
            WHEN status = 'pending_deposit' 
            AND hold_until <= NOW() 
            THEN 1 ELSE 0 
          END) AS pendingExpired,
          
          SUM(CASE 
            WHEN status = 'pending_deposit' 
            THEN COALESCE(deposit_decimal, 0) ELSE 0 
          END) AS amountHeld,
          
          SUM(CASE 
            WHEN deposit_paid_at IS NOT NULL 
            AND DATE(deposit_paid_at) = CURDATE() 
            THEN 1 ELSE 0 
          END) AS paidToday,
          
          SUM(CASE 
            WHEN status = 'cancelled' 
            AND DATE(updated_at) = CURDATE() 
            AND hold_until IS NOT NULL 
            THEN 1 ELSE 0 
          END) AS cancelledToday
        FROM appointment
      `);

      // Turnos próximos a vencer (< 2 horas)
      const [expiringSoon] = await conn.query(`
        SELECT 
          a.id,
          a.hold_until,
          c.name AS customer_name,
          s.name AS service_name,
          TIMESTAMPDIFF(MINUTE, NOW(), a.hold_until) AS minutes_left
        FROM appointment a
        JOIN customer c ON c.id = a.customer_id
        JOIN service s ON s.id = a.service_id
        WHERE a.status = 'pending_deposit'
          AND a.hold_until > NOW()
          AND a.hold_until <= DATE_ADD(NOW(), INTERVAL 2 HOUR)
        ORDER BY a.hold_until ASC
      `);

      // Pagos recientes (últimas 24hs)
      const [recentPayments] = await conn.query(`
        SELECT 
          a.id,
          a.deposit_decimal,
          a.deposit_paid_at,
          c.name AS customer_name,
          s.name AS service_name
        FROM appointment a
        JOIN customer c ON c.id = a.customer_id
        JOIN service s ON s.id = a.service_id
        WHERE a.deposit_paid_at IS NOT NULL
          AND a.deposit_paid_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        ORDER BY a.deposit_paid_at DESC
        LIMIT 10
      `);

      res.json({
        ok: true,
        data: {
          stats: {
            pendingActive: Number(stats.pendingActive || 0),
            pendingExpired: Number(stats.pendingExpired || 0),
            amountHeld: Number(stats.amountHeld || 0),
            paidToday: Number(stats.paidToday || 0),
            cancelledToday: Number(stats.cancelledToday || 0),
          },
          expiringSoon,
          recentPayments,
        },
      });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("[DEPOSITS/DASHBOARD] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// PENDING - Lista de señas pendientes
// ============================================
depositsAdmin.get("/pending", async (req, res) => {
  try {
    const includeExpired = req.query.includeExpired === "true";
    
    const whereClause = includeExpired
      ? "a.status = 'pending_deposit'"
      : "a.status = 'pending_deposit' AND a.hold_until > NOW()";

    const [deposits] = await pool.query(`
      SELECT 
        a.id,
        a.starts_at,
        a.hold_until,
        a.deposit_decimal,
        c.name AS customer_name,
        c.phone_e164,
        s.name AS service_name,
        st.name AS stylist_name,
        CASE
          WHEN a.hold_until <= NOW() THEN 'expired'
          WHEN a.hold_until <= DATE_ADD(NOW(), INTERVAL 2 HOUR) THEN 'expiring'
          ELSE 'active'
        END AS urgency
      FROM appointment a
      JOIN customer c ON c.id = a.customer_id
      JOIN service s ON s.id = a.service_id
      JOIN stylist st ON st.id = a.stylist_id
      WHERE ${whereClause}
      ORDER BY 
        CASE
          WHEN a.hold_until <= NOW() THEN 0
          WHEN a.hold_until <= DATE_ADD(NOW(), INTERVAL 2 HOUR) THEN 1
          ELSE 2
        END,
        a.hold_until ASC
    `);

    res.json({ ok: true, data: deposits });
  } catch (e) {
    console.error("[DEPOSITS/PENDING] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// ACTIONS - Acciones sobre depósitos
// ============================================

// Marcar como pagado
depositsAdmin.post("/:id/mark-paid", async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.query(`
      UPDATE appointment
      SET 
        status = 'deposit_paid',
        deposit_paid_at = NOW(),
        hold_until = NULL
      WHERE id = ? AND status = 'pending_deposit'
    `, [id]);

    // Registrar en actividad
    await logActivity({
      type: "deposit_paid",
      appointmentId: id,
      userId: req.user.id,
      description: "Seña marcada como pagada manualmente",
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[DEPOSITS/MARK-PAID] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cancelar turno
depositsAdmin.post("/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.query(`
      UPDATE appointment
      SET status = 'cancelled'
      WHERE id = ?
    `, [id]);

    // Registrar en actividad
    await logActivity({
      type: "appointment_cancelled",
      appointmentId: id,
      userId: req.user.id,
      description: "Turno cancelado por timeout de seña",
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[DEPOSITS/CANCEL] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Extender tiempo de hold
depositsAdmin.post("/:id/extend", async (req, res) => {
  try {
    const { id } = req.params;
    const minutes = Number(req.body.minutes || 30);
    
    await pool.query(`
      UPDATE appointment
      SET hold_until = DATE_ADD(COALESCE(hold_until, NOW()), INTERVAL ? MINUTE)
      WHERE id = ? AND status = 'pending_deposit'
    `, [minutes, id]);

    // Registrar en actividad
    await logActivity({
      type: "deposit_extended",
      appointmentId: id,
      userId: req.user.id,
      description: `Tiempo de hold extendido ${minutes} minutos`,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[DEPOSITS/EXTEND] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Enviar recordatorio
depositsAdmin.post("/:id/remind", async (req, res) => {
  try {
    const { id } = req.params;
    
    // Aquí irían las integraciones con WhatsApp/SMS
    // Por ahora solo registramos la acción
    
    await logActivity({
      type: "reminder_sent",
      appointmentId: id,
      userId: req.user.id,
      description: "Recordatorio de pago enviado",
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[DEPOSITS/REMIND] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// CONFIG - Configuración del sistema
// ============================================
depositsAdmin.get("/config", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT config_key, config_value, updated_at
      FROM system_config
      WHERE config_key LIKE 'deposit_%'
      ORDER BY config_key
    `);

    // Convertir array a objeto
    const config = rows.reduce((acc, row) => {
      const key = row.config_key.replace("deposit_", "");
      let value = row.config_value;
      
      // Parse JSON values
      try {
        value = JSON.parse(value);
      } catch {}
      
      acc[key] = value;
      return acc;
    }, {});

    // Valores por defecto si no existen
    const defaultConfig = {
      percentage: 50,
      hold_minutes: 30,
      expiration_before_start_minutes: 120,
      auto_cancel: true,
      notifications: {
        expiringSoon: true,
        expired: true,
        paid: true,
      },
    };

    res.json({ 
      ok: true, 
      data: { ...defaultConfig, ...config } 
    });
  } catch (e) {
    console.error("[DEPOSITS/CONFIG/GET] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

depositsAdmin.post("/config", async (req, res) => {
  try {
    const config = req.body;
    const conn = await pool.getConnection();
    
    try {
      await conn.beginTransaction();
      
      // Guardar cada configuración
      for (const [key, value] of Object.entries(config)) {
        const configKey = `deposit_${key}`;
        const configValue = typeof value === "object" 
          ? JSON.stringify(value) 
          : String(value);
        
        await conn.query(`
          INSERT INTO system_config (config_key, config_value)
          VALUES (?, ?)
          ON DUPLICATE KEY UPDATE
            config_value = VALUES(config_value),
            updated_at = NOW()
        `, [configKey, configValue]);
      }
      
      // Registrar cambio en actividad
      await logActivity({
        type: "config_changed",
        userId: req.user.id,
        description: "Configuración de depósitos actualizada",
        details: JSON.stringify(config),
      }, conn);
      
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("[DEPOSITS/CONFIG/POST] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// ACTIVITY - Registro de actividad
// ============================================
depositsAdmin.get("/activity", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    
    const [activities] = await pool.query(`
      SELECT 
        al.id,
        al.type,
        al.description,
        al.details,
        al.created_at,
        al.appointment_id,
        u.email AS user_email,
        u.full_name AS user_name,
        c.name AS customer_name
      FROM activity_log al
      LEFT JOIN users u ON u.id = al.user_id
      LEFT JOIN appointment a ON a.id = al.appointment_id
      LEFT JOIN customer c ON c.id = a.customer_id
      WHERE al.module = 'deposits'
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    // Formatear para el frontend
    const formatted = activities.map(act => ({
      id: act.id,
      type: act.type,
      description: act.description,
      details: act.details,
      created_at: act.created_at,
      user: act.user_name || act.user_email || "Sistema",
      customer: act.customer_name,
    }));

    res.json({ ok: true, data: formatted });
  } catch (e) {
    console.error("[DEPOSITS/ACTIVITY] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// HELPER: Registrar actividad
// ============================================
async function logActivity({
  type,
  appointmentId = null,
  userId = null,
  description,
  details = null,
}, conn = pool) {
  await conn.query(`
    INSERT INTO activity_log 
    (module, type, appointment_id, user_id, description, details, created_at)
    VALUES ('deposits', ?, ?, ?, ?, ?, NOW())
  `, [type, appointmentId, userId, description, details]);
}

export default depositsAdmin;