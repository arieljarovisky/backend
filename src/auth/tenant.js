// src/middleware/tenant.js
/**
 * ═══════════════════════════════════════════════════════════
 * TENANT MIDDLEWARE - Multi-Tenancy Security
 * ═══════════════════════════════════════════════════════════
 * 
 * Asegura que cada peluquería solo vea sus propios datos.
 * CRÍTICO: Sin esto, las peluquerías podrían ver datos de otras.
 */

import { pool } from "../db.js";

/**
 * Extrae el tenant_id del request
 * Prioridad:
 * 1. JWT (más seguro)
 * 2. Subdomain (www.peluqueria1.tusistema.com)
 * 3. Header X-Tenant-ID (para APIs externas)
 */
export async function identifyTenant(req, res, next) {
  try {
    let tenantId = null;
    let tenant = null;

    // ✅ Opción 1: Desde JWT (después de requireAuth)
    if (req.user?.tenant_id) {
      tenantId = req.user.tenant_id;
    }

    // ✅ Opción 2: Desde subdomain
    if (!tenantId) {
      const subdomain = extractSubdomain(req);
      if (subdomain && subdomain !== 'www' && subdomain !== 'api') {
        const [[t]] = await pool.query(
          'SELECT id, status FROM tenant WHERE subdomain = ? LIMIT 1',
          [subdomain]
        );
        if (t) {
          tenantId = t.id;
          tenant = t;
        }
      }
    }

    // ✅ Opción 3: Desde header (para APIs/webhooks)
    if (!tenantId && req.headers['x-tenant-id']) {
      tenantId = Number(req.headers['x-tenant-id']);
      const [[t]] = await pool.query(
        'SELECT id, status FROM tenant WHERE id = ? LIMIT 1',
        [tenantId]
      );
      if (t) tenant = t;
    }

    // ⚠️ Si no se pudo identificar tenant
    if (!tenantId) {
      return res.status(403).json({
        ok: false,
        error: 'Tenant no identificado. Acceso denegado.',
        hint: 'Usar subdomain o header X-Tenant-ID'
      });
    }

    // ⚠️ Verificar que el tenant esté activo
    if (!tenant) {
      const [[t]] = await pool.query(
        'SELECT id, status, subscription_status FROM tenant WHERE id = ? LIMIT 1',
        [tenantId]
      );
      tenant = t;
    }

    if (!tenant) {
      return res.status(404).json({
        ok: false,
        error: 'Tenant no encontrado'
      });
    }

    if (tenant.status !== 'active') {
      return res.status(403).json({
        ok: false,
        error: 'Cuenta suspendida. Contactar soporte.',
        status: tenant.status
      });
    }

    // ✅ Agregar tenant_id al request
    req.tenant_id = tenantId;
    req.tenant = tenant;

    next();
  } catch (err) {
    console.error('[TENANT] Error:', err);
    res.status(500).json({
      ok: false,
      error: 'Error al identificar tenant'
    });
  }
}

/**
 * Middleware que requiere tenant (usar después de identifyTenant)
 */
export function requireTenant(req, res, next) {
  if (!req.tenant_id) {
    return res.status(403).json({
      ok: false,
      error: 'Tenant requerido'
    });
  }
  next();
}

/**
 * Middleware para super admin (gestiona todos los tenants)
 */
export function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_super_admin) {
    return res.status(403).json({
      ok: false,
      error: 'Solo super admin'
    });
  }
  next();
}

/**
 * Helper: Extraer subdomain del hostname
 */
function extractSubdomain(req) {
  const hostname = req.hostname || req.headers.host?.split(':')[0] || '';
  
  // localhost → null
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return null;
  }

  // peluqueria1.tusistema.com → peluqueria1
  const parts = hostname.split('.');
  if (parts.length >= 3) {
    return parts[0];
  }

  return null;
}

/**
 * Helper: Verificar límites del plan
 */
export async function checkPlanLimit(tenantId, limitType) {
  try {
    // Obtener límites del plan actual
    const [[subscription]] = await pool.query(
      `SELECT sp.* 
       FROM subscription s
       JOIN subscription_plan sp ON sp.id = s.plan_id
       WHERE s.tenant_id = ? 
       ORDER BY s.created_at DESC 
       LIMIT 1`,
      [tenantId]
    );

    if (!subscription) {
      return { allowed: false, reason: 'Sin suscripción activa' };
    }

    const features = JSON.parse(subscription.features || '[]');

    // Verificar feature
    if (limitType === 'facturacion' && !features.includes('facturacion')) {
      return {
        allowed: false,
        reason: 'Facturación no disponible en tu plan',
        upgrade: true
      };
    }

    // Verificar límites numéricos
    if (limitType === 'stylists') {
      const maxStylists = subscription.max_stylists;
      if (maxStylists !== null) {
        const [[{ count }]] = await pool.query(
          'SELECT COUNT(*) as count FROM stylist WHERE tenant_id = ? AND is_active = TRUE',
          [tenantId]
        );
        if (count >= maxStylists) {
          return {
            allowed: false,
            reason: `Límite de ${maxStylists} peluqueros alcanzado`,
            current: count,
            max: maxStylists,
            upgrade: true
          };
        }
      }
    }

    if (limitType === 'appointments') {
      const maxAppointments = subscription.max_appointments_month;
      if (maxAppointments !== null) {
        const [[{ count }]] = await pool.query(
          `SELECT COUNT(*) as count 
           FROM appointment 
           WHERE tenant_id = ? 
           AND YEAR(starts_at) = YEAR(NOW()) 
           AND MONTH(starts_at) = MONTH(NOW())`,
          [tenantId]
        );
        if (count >= maxAppointments) {
          return {
            allowed: false,
            reason: `Límite de ${maxAppointments} turnos/mes alcanzado`,
            current: count,
            max: maxAppointments,
            upgrade: true
          };
        }
      }
    }

    return { allowed: true };
  } catch (err) {
    console.error('[CHECK_LIMIT] Error:', err);
    return { allowed: true }; // Fail open (permitir en caso de error)
  }
}

/**
 * Middleware para verificar feature
 */
export function requireFeature(featureName) {
  return async (req, res, next) => {
    const check = await checkPlanLimit(req.tenant_id, featureName);
    if (!check.allowed) {
      return res.status(403).json({
        ok: false,
        error: check.reason,
        upgrade_required: check.upgrade || false
      });
    }
    next();
  };
}

/**
 * Helper: Obtener configuración del tenant
 */
export async function getTenantSettings(tenantId) {
  const [[tenant]] = await pool.query(
    `SELECT * FROM tenant WHERE id = ?`,
    [tenantId]
  );

  const [[settings]] = await pool.query(
    `SELECT * FROM tenant_settings WHERE tenant_id = ?`,
    [tenantId]
  );

  return {
    ...tenant,
    ...settings
  };
}

/**
 * Middleware para agregar configuración del tenant al request
 */
export async function loadTenantSettings(req, res, next) {
  if (!req.tenant_id) {
    return next();
  }

  try {
    const settings = await getTenantSettings(req.tenant_id);
    req.tenant_settings = settings;
    next();
  } catch (err) {
    console.error('[TENANT_SETTINGS] Error:', err);
    next(); // Continue sin settings
  }
}

/**
 * Helper: Query seguro con tenant_id automático
 */
export function createTenantQuery(req) {
  const tenantId = req.tenant_id;
  
  return {
    // SELECT con tenant_id automático
    query: async (sql, params = []) => {
      // Agregar tenant_id a WHERE si no existe
      if (!sql.toLowerCase().includes('tenant_id')) {
        if (sql.toLowerCase().includes('where')) {
          sql = sql.replace(/WHERE/i, 'WHERE tenant_id = ? AND');
          params = [tenantId, ...params];
        } else if (sql.toLowerCase().includes('from')) {
          sql = sql.replace(/FROM\s+(\w+)/i, 'FROM $1 WHERE tenant_id = ?');
          params = [tenantId, ...params];
        }
      }
      return pool.query(sql, params);
    },
    
    // INSERT con tenant_id automático
    insert: async (table, data) => {
      data.tenant_id = tenantId;
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => '?').join(',');
      
      const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`;
      return pool.query(sql, values);
    },
    
    // UPDATE con tenant_id automático
    update: async (table, data, whereClause, whereParams = []) => {
      const sets = Object.keys(data).map(k => `${k} = ?`).join(',');
      const values = Object.values(data);
      
      const sql = `UPDATE ${table} SET ${sets} WHERE tenant_id = ? AND ${whereClause}`;
      return pool.query(sql, [...values, tenantId, ...whereParams]);
    }
  };
}

/**
 * Verificar suscripción activa
 */
export async function requireActiveSubscription(req, res, next) {
  try {
    const [[sub]] = await pool.query(
      `SELECT status, current_period_end 
       FROM subscription 
       WHERE tenant_id = ? 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [req.tenant_id]
    );

    if (!sub) {
      return res.status(402).json({
        ok: false,
        error: 'Sin suscripción activa',
        action: 'subscribe'
      });
    }

    if (sub.status === 'cancelled') {
      return res.status(402).json({
        ok: false,
        error: 'Suscripción cancelada',
        action: 'resubscribe'
      });
    }

    if (sub.status === 'past_due') {
      return res.status(402).json({
        ok: false,
        error: 'Pago pendiente. Actualizar método de pago.',
        action: 'update_payment'
      });
    }

    // ⚠️ Trial expirado
    if (sub.status === 'trial' && new Date(sub.current_period_end) < new Date()) {
      return res.status(402).json({
        ok: false,
        error: 'Trial expirado. Suscribirse para continuar.',
        action: 'subscribe',
        trial_ended: true
      });
    }

    next();
  } catch (err) {
    console.error('[SUBSCRIPTION_CHECK] Error:', err);
    next(); // Fail open
  }
}

export default {
  identifyTenant,
  requireTenant,
  requireSuperAdmin,
  requireFeature,
  loadTenantSettings,
  checkPlanLimit,
  getTenantSettings,
  createTenantQuery,
  requireActiveSubscription
};