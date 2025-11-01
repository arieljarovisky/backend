// src/routes/invoicing.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";
import {
  generarFactura,
  consultarFactura,
  generarNotaCredito,
  verificarConexion,
  calcularIVA,
  determinarTipoComprobante,
  validarDatosFacturacion,
  COMPROBANTE_TIPOS,
  DOCUMENTO_TIPOS,
  CONCEPTOS,
  CONDICIONES_IVA,
} from "../services/arca.js";

export const invoicing = Router();
invoicing.use(requireAuth, requireRole("admin", "user"));

// ============================================
// HEALTH CHECK ARCA
// ============================================
invoicing.get("/health", async (req, res) => {
  try {
    const status = await verificarConexion();
    res.json({ ok: true, arca: status });
  } catch (err) {
    console.error("[INVOICING/HEALTH] error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================
// GENERAR FACTURA PARA UN TURNO
// ============================================
invoicing.post("/appointment/:id", async (req, res) => {
  const conn = await pool.getConnection();
  const tenantId = req.tenant.id;

  try {
    await conn.beginTransaction();

    const appointmentId = Number(req.params.id);

    // 1. Verificar que el turno exista en este tenant
    const [[appt]] = await conn.query(
      `SELECT 
        a.id,
        a.status,
        a.starts_at,
        c.id AS customer_id,
        c.name AS customer_name,
        c.phone_e164,
        c.documento,
        c.tipo_documento,
        c.cuit,
        c.domicilio,
        c.condicion_iva,
        s.id AS service_id,
        s.name AS service_name,
        s.price_decimal,
        st.name AS stylist_name
      FROM appointment a
      JOIN customer c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
      JOIN service  s ON s.id = a.service_id  AND s.tenant_id = a.tenant_id
      JOIN stylist  st ON st.id = a.stylist_id AND st.tenant_id = a.tenant_id
      WHERE a.id = ? AND a.tenant_id = ?
      FOR UPDATE`,
      [appointmentId, tenantId]
    );

    if (!appt) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    // 2. Verificar si ya tiene factura
    const [[existing]] = await conn.query(
      `SELECT id FROM invoice WHERE appointment_id = ? AND tenant_id = ? LIMIT 1`,
      [appointmentId, tenantId]
    );

    if (existing) {
      await conn.rollback();
      return res.status(400).json({
        ok: false,
        error: "Este turno ya tiene una factura generada",
        invoice_id: existing.id,
      });
    }

    // 3. Validar datos del cliente
    const validacion = validarDatosFacturacion({
      razon_social: appt.customer_name,
      documento: appt.documento,
      cuit: appt.cuit,
      condicion_iva: appt.condicion_iva,
    });

    if (!validacion.valid) {
      await conn.rollback();
      return res.status(400).json({
        ok: false,
        error: "Datos insuficientes para facturar",
        errors: validacion.errors,
      });
    }

    // 4. Tipo de comprobante
    const tipoComprobante = determinarTipoComprobante(
      appt.condicion_iva || CONDICIONES_IVA.CONSUMIDOR_FINAL
    );

    // 5. Calcular IVA
    const precio = Number(appt.price_decimal || 0);
    const { neto, iva, total } = calcularIVA(precio);

    // 6. Payload para Arca
    const facturaParams = {
      tipo_comprobante: tipoComprobante,
      concepto: CONCEPTOS.SERVICIOS,
      tipo_doc_cliente: appt.tipo_documento || DOCUMENTO_TIPOS.DNI,
      doc_cliente: appt.documento || "",
      cuit_cliente: appt.cuit || null,
      razon_social: appt.customer_name || "Consumidor Final",
      domicilio: appt.domicilio || "Sin domicilio",
      condicion_iva: appt.condicion_iva || CONDICIONES_IVA.CONSUMIDOR_FINAL,
      items: [
        {
          descripcion: `${appt.service_name} - ${appt.stylist_name}`,
          cantidad: 1,
          precio_unitario: neto,
          alicuota_iva: 21,
          codigo: `SVC-${appt.service_id}`,
        },
      ],
      importe_neto: neto,
      importe_iva: iva,
      importe_total: total,
      referencia_interna: `APPT-${appointmentId}`,
      observaciones: `Turno #${appointmentId} - Fecha: ${appt.starts_at}`,
    };

    const arcaResponse = await generarFactura(facturaParams);
    if (!arcaResponse.success) throw new Error("Arca no pudo generar la factura");

    // 7. Insert factura en DB (con tenant)
    const [invoiceResult] = await conn.query(
      `INSERT INTO invoice (
        tenant_id,
        appointment_id,
        customer_id,
        tipo_comprobante,
        punto_venta,
        numero_comprobante,
        cae,
        vto_cae,
        fecha_emision,
        importe_neto,
        importe_iva,
        importe_total,
        pdf_url,
        xml_url,
        arca_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        tenantId,
        appointmentId,
        appt.customer_id,
        arcaResponse.tipo_comprobante,
        arcaResponse.punto_venta,
        arcaResponse.numero,
        arcaResponse.cae,
        arcaResponse.vto_cae,
        arcaResponse.fecha_emision,
        neto,
        iva,
        total,
        arcaResponse.pdf_url,
        arcaResponse.xml_url,
        arcaResponse.hash,
      ]
    );

    const invoiceId = invoiceResult.insertId;

    // 8. Marcar turno como facturado
    await conn.query(
      `UPDATE appointment SET invoiced = 1 WHERE id = ? AND tenant_id = ?`,
      [appointmentId, tenantId]
    );

    await conn.commit();

    res.json({
      ok: true,
      invoice_id: invoiceId,
      cae: arcaResponse.cae,
      numero: arcaResponse.numero,
      tipo_comprobante: arcaResponse.tipo_comprobante,
      punto_venta: arcaResponse.punto_venta,
      total,
      pdf_url: arcaResponse.pdf_url,
    });
  } catch (err) {
    await conn.rollback();
    console.error("[INVOICING] Error generando factura:", err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ============================================
// CONSULTAR FACTURA
// ============================================
invoicing.get("/invoice/:id", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const invoiceId = Number(req.params.id);

    const [[invoice]] = await pool.query(
      `SELECT 
        i.*, a.starts_at, c.name AS customer_name, c.documento, s.name AS service_name
       FROM invoice i
       LEFT JOIN appointment a ON a.id = i.appointment_id AND a.tenant_id=i.tenant_id
       LEFT JOIN customer c ON c.id = i.customer_id AND c.tenant_id=i.tenant_id
       LEFT JOIN service  s ON s.id = a.service_id AND s.tenant_id=i.tenant_id
      WHERE i.id = ? AND i.tenant_id = ?`,
      [invoiceId, tenantId]
    );

    if (!invoice)
      return res.status(404).json({ ok: false, error: "Factura no encontrada" });

    res.json({ ok: true, data: invoice });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================
// LISTAR FACTURAS (scopiadas al tenant)
// ============================================
invoicing.get("/invoices", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { from, to, customerId, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT i.*, a.starts_at, c.name AS customer_name, c.documento, s.name AS service_name
      FROM invoice i
      LEFT JOIN appointment a ON a.id=i.appointment_id AND a.tenant_id=i.tenant_id
      LEFT JOIN customer c ON c.id=i.customer_id AND c.tenant_id=i.tenant_id
      LEFT JOIN service s ON s.id=a.service_id AND s.tenant_id=i.tenant_id
      WHERE i.tenant_id = ?
    `;
    const params = [tenantId];

    if (from) { sql += " AND i.fecha_emision >= ?"; params.push(`${from} 00:00:00`); }
    if (to)   { sql += " AND i.fecha_emision <= ?"; params.push(`${to} 23:59:59`); }
    if (customerId) { sql += " AND i.customer_id = ?"; params.push(Number(customerId)); }

    sql += " ORDER BY i.created_at DESC LIMIT ? OFFSET ?";
    params.push(Number(limit), Number(offset));

    const [invoices] = await pool.query(sql, params);
    res.json({ ok: true, data: invoices });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================
// GENERAR NOTA DE CRÉDITO
// ============================================
invoicing.post("/credit-note/:invoiceId", async (req, res) => {
  const conn = await pool.getConnection();
  const tenantId = req.tenant.id;

  try {
    await conn.beginTransaction();

    const invoiceId = Number(req.params.invoiceId);
    const { motivo } = req.body;

    // 1. Buscar factura original dentro del tenant
    const [[original]] = await conn.query(
      `SELECT * FROM invoice WHERE id = ? AND tenant_id = ? FOR UPDATE`,
      [invoiceId, tenantId]
    );
    if (!original) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Factura no encontrada" });
    }

    // 2. Evitar duplicado
    const [[existingNC]] = await conn.query(
      `SELECT id FROM invoice WHERE original_invoice_id = ? AND tenant_id = ? LIMIT 1`,
      [invoiceId, tenantId]
    );
    if (existingNC) {
      await conn.rollback();
      return res.status(400).json({ ok:false, error:"Ya existe nota de crédito para esta factura" });
    }

    // 3. Generar nota crédito en Arca
    const ncParams = {
      tipo_comprobante_original: original.tipo_comprobante,
      punto_venta_original: original.punto_venta,
      numero_original: original.numero_comprobante,
      tipo_doc_cliente: original.tipo_doc_cliente,
      doc_cliente: original.doc_cliente,
      razon_social: original.razon_social,
      domicilio: original.domicilio,
      condicion_iva: original.condicion_iva,
      items: [
        {
          descripcion: `Devolución - ${motivo || "Sin especificar"}`,
          cantidad: 1,
          precio_unitario: original.importe_neto,
          alicuota_iva: 21,
        },
      ],
      importe_neto: original.importe_neto,
      importe_iva: original.importe_iva,
      importe_total: original.importe_total,
      referencia_interna: `NC-${invoiceId}`,
      observaciones: `Nota de crédito ${original.numero_comprobante}`,
    };
    const arcaResponse = await generarNotaCredito(ncParams);

    // 4. Insertar nota crédito
    await conn.query(
      `INSERT INTO invoice (
        tenant_id, customer_id, appointment_id, original_invoice_id,
        tipo_comprobante, punto_venta, numero_comprobante,
        cae, vto_cae, fecha_emision,
        importe_neto, importe_iva, importe_total,
        pdf_url, xml_url, arca_hash, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, NOW())`,
      [
        tenantId,
        original.customer_id,
        original.appointment_id,
        invoiceId,
        arcaResponse.tipo_comprobante,
        arcaResponse.punto_venta,
        arcaResponse.numero,
        arcaResponse.cae,
        arcaResponse.vto_cae,
        arcaResponse.fecha_emision,
        -Math.abs(original.importe_neto),
        -Math.abs(original.importe_iva),
        -Math.abs(original.importe_total),
        arcaResponse.pdf_url,
        arcaResponse.xml_url,
        arcaResponse.hash,
      ]
    );

    await conn.commit();
    res.json({ ok:true, cae:arcaResponse.cae, numero:arcaResponse.numero });
  } catch (e) {
    await conn.rollback();
    console.error("[CREDIT NOTE ERROR]", e);
    res.status(500).json({ ok:false, error:e.message });
  } finally {
    conn.release();
  }
});

// ============================================
// STATS (tenant-scoped)
// ============================================
invoicing.get("/stats", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { from, to } = req.query;

    const where = ["tenant_id = ?"];
    const params = [tenantId];

    if (from && to) {
      where.push("fecha_emision BETWEEN ? AND ?");
      params.push(`${from} 00:00:00`, `${to} 23:59:59`);
    }

    const [[stats]] = await pool.query(
      `SELECT
        COUNT(*) AS total_facturas,
        SUM(CASE WHEN tipo_comprobante IN (1,6,11) THEN 1 ELSE 0 END) AS facturas,
        SUM(CASE WHEN tipo_comprobante IN (3,8,13) THEN 1 ELSE 0 END) AS notas_credito,
        SUM(CASE WHEN tipo_comprobante IN (1,6,11) THEN importe_total ELSE 0 END) AS total_facturado,
        SUM(CASE WHEN tipo_comprobante IN (3,8,13) THEN importe_total ELSE 0 END) AS total_nc
      FROM invoice
      WHERE ${where.join(" AND ")}`,
      params
    );

    res.json({
      ok:true,
      data:{
        total_facturas:Number(stats.total_facturas||0),
        facturas:Number(stats.facturas||0),
        notas_credito:Number(stats.notas_credito||0),
        total_facturado:Number(stats.total_facturado||0),
        total_nc:Math.abs(Number(stats.total_nc||0)),
        neto:Number(stats.total_facturado||0)-Math.abs(Number(stats.total_nc||0))
      }
    });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

export default invoicing;
