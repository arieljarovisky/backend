import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const adminDashboard = Router();

adminDashboard.use(requireAuth, requireRole("admin", "staff"));

adminDashboard.get("/", async (req, res) => {
  try {
    const { from, to } = req.query || {};

    const ACTIVE = ["scheduled", "confirmed", "deposit_paid", "completed", "pending_deposit"];
    const ACTIVE_NO_PENDING = ["scheduled", "confirmed", "deposit_paid", "completed"];

    const hasRange = Boolean(from && to);
    const rangeWhere = hasRange ? "a.starts_at BETWEEN ? AND ?" : "1=1";
    const rangeParams = hasRange ? [`${from} 00:00:00`, `${to} 23:59:59`] : [];

    // ===== HOY / MAÑANA (conteos) =====
    const [[todayAll]] = await pool.query(
      `
      SELECT
        SUM(CASE WHEN status IN (${ACTIVE.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS active_total,
        SUM(CASE WHEN status = 'pending_deposit' THEN 1 ELSE 0 END) AS pending_total,
        SUM(CASE WHEN status IN (${ACTIVE_NO_PENDING.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS confirmed_total
      FROM appointment
      WHERE DATE(starts_at) = CURDATE()
      `,
      [...ACTIVE, ...ACTIVE_NO_PENDING]
    );

    const [[tomorrowAll]] = await pool.query(
      `
      SELECT
        SUM(CASE WHEN status IN (${ACTIVE.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS active_total,
        SUM(CASE WHEN status = 'pending_deposit' THEN 1 ELSE 0 END) AS pending_total,
        SUM(CASE WHEN status IN (${ACTIVE_NO_PENDING.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS confirmed_total
      FROM appointment
      WHERE DATE(starts_at) = CURDATE() + INTERVAL 1 DAY
      `,
      [...ACTIVE, ...ACTIVE_NO_PENDING]
    );

    // ===== Clientes =====
    const [[totalCustomers]] = await pool.query(`SELECT COUNT(*) AS total FROM customer`);

    // ===== Por estilista (desde hoy o rango) =====
    const [byStylist] = await pool.query(
      `
      SELECT
        st.id,
        st.name AS stylist,
        st.color_hex,
        SUM(CASE WHEN a.status IN (${ACTIVE.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN a.status = 'pending_deposit' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN a.status IN (${ACTIVE_NO_PENDING.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS confirmed
      FROM stylist st
      LEFT JOIN appointment a ON a.stylist_id = st.id
        AND ${hasRange ? "a.starts_at BETWEEN ? AND ?" : "a.starts_at >= CURDATE()"}
      GROUP BY st.id, st.name, st.color_hex
      ORDER BY st.name
      `,
      [
        ...ACTIVE,
        ...ACTIVE_NO_PENDING,
        ...(hasRange ? [`${from} 00:00:00`, `${to} 23:59:59`] : []),
      ]
    );

    // ===== Recaudación por SEÑAS =====
    // Hoy (deposit_paid_at hoy)
    const [[todayDeposits]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(deposit_decimal), 0) AS amount,
        COUNT(*) AS count
      FROM appointment
      WHERE deposit_paid_at IS NOT NULL
        AND DATE(deposit_paid_at) = CURDATE()
      `
    );

    // En el rango (si viene), si no: desde inicio del mes actual
    const depositsRangeWhere = hasRange
      ? "deposit_paid_at BETWEEN ? AND ?"
      : "deposit_paid_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
    const depositsRangeParams = hasRange
      ? [`${from} 00:00:00`, `${to} 23:59:59`]
      : [];
    const [[rangeDeposits]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(deposit_decimal), 0) AS amount,
        COUNT(*) AS count
      FROM appointment
      WHERE deposit_paid_at IS NOT NULL
        AND ${depositsRangeWhere}
      `,
      depositsRangeParams
    );

    // ===== Facturación (servicios) =====
    // Realizada: servicios COMPLETED en el rango (o mes actual)
    const revenueRangeWhere = hasRange ? rangeWhere : "a.starts_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
    const revenueRangeParams = hasRange ? rangeParams : [];
    const [[realizedRevenue]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(s.price_decimal), 0) AS amount,
        COUNT(*) AS count
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE ${revenueRangeWhere}
        AND a.status = 'completed'
      `,
      revenueRangeParams
    );

    // Proyección: turnos no cancelados y no pendientes (según ACTIVE_NO_PENDING)
    const [[projectedRevenue]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(s.price_decimal), 0) AS amount,
        COUNT(*) AS count
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE ${revenueRangeWhere}
        AND a.status IN (${ACTIVE_NO_PENDING.map(() => "?").join(",")})
      `,
      [...revenueRangeParams, ...ACTIVE_NO_PENDING]
    );

    // ===== Señales por vencer / vencidas =====
    const [[holdsSoon]] = await pool.query(
      `
      SELECT COUNT(*) AS soon
      FROM appointment
      WHERE status = 'pending_deposit'
        AND hold_until IS NOT NULL
        AND hold_until > NOW()
        AND hold_until <= DATE_ADD(NOW(), INTERVAL 2 HOUR)
      `
    );
    const [[holdsExpired]] = await pool.query(
      `
      SELECT COUNT(*) AS expired
      FROM appointment
      WHERE status = 'pending_deposit'
        AND hold_until IS NOT NULL
        AND hold_until <= NOW()
      `
    );

    res.json({
      ok: true,
      data: {
        today: {
          total: Number(todayAll.active_total || 0),
          pending: Number(todayAll.pending_total || 0),
          confirmed: Number(todayAll.confirmed_total || 0),
        },
        tomorrow: {
          total: Number(tomorrowAll.active_total || 0),
          pending: Number(tomorrowAll.pending_total || 0),
          confirmed: Number(tomorrowAll.confirmed_total || 0),
        },
        customers: Number(totalCustomers.total || 0),
        byStylist: byStylist.map((r) => ({
          stylistId: r.id,
          stylist: r.stylist,
          color_hex: r.color_hex,
          total: Number(r.total || 0),
          pending: Number(r.pending || 0),
          confirmed: Number(r.confirmed || 0),
        })),
        deposits: {
          todayAmount: Number(todayDeposits.amount || 0),
          todayCount: Number(todayDeposits.count || 0),
          rangeAmount: Number(rangeDeposits.amount || 0),
          rangeCount: Number(rangeDeposits.count || 0),
        },
        revenue: {
          realizedAmount: Number(realizedRevenue.amount || 0),
          realizedCount: Number(realizedRevenue.count || 0),
          projectedAmount: Number(projectedRevenue.amount || 0),
          projectedCount: Number(projectedRevenue.count || 0),
        },
        holds: {
          expiringSoon: Number(holdsSoon.soon || 0),
          expired: Number(holdsExpired.expired || 0),
        },
        range: hasRange ? { from, to } : { from: null, to: null },
      },
    });
  } catch (e) {
    console.error("[DASHBOARD] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
