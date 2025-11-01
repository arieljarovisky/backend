// src/services/arca.js
/**
 * ═══════════════════════════════════════════════════════════
 * INTEGRACIÓN ARCA - FACTURACIÓN ELECTRÓNICA ARGENTINA
 * ═══════════════════════════════════════════════════════════
 * 
 * Este servicio se conecta con Arca para generar facturas
 * electrónicas válidas ante AFIP de forma manual desde el admin.
 * 
 * Documentación oficial: https://developers.arca.com.ar
 * 
 * IMPORTANTE: 
 * - Necesitás tener cuenta en Arca (https://arca.com.ar)
 * - Configurar punto de venta en AFIP
 * - Obtener API Key desde el panel de Arca
 */

import crypto from "crypto";

// ============================================
// CONFIGURACIÓN - Leer desde .env
// ============================================
const ARCA_API_URL = process.env.ARCA_API_URL || "https://api.arca.com.ar/v1";
const ARCA_API_KEY = process.env.ARCA_API_KEY || "";
const ARCA_CUIT = process.env.ARCA_CUIT || ""; // Tu CUIT de 11 dígitos
const ARCA_PUNTO_VENTA = process.env.ARCA_PUNTO_VENTA || "1";
const ARCA_TIMEOUT_MS = Number(process.env.ARCA_TIMEOUT_MS || 15000);

// Tipos de comprobante AFIP
export const COMPROBANTE_TIPOS = {
  FACTURA_A: 1,
  FACTURA_B: 6,
  FACTURA_C: 11,
  NOTA_CREDITO_A: 3,
  NOTA_CREDITO_B: 8,
  NOTA_CREDITO_C: 13,
  RECIBO: 4,
  NOTA_DEBITO_A: 2,
  NOTA_DEBITO_B: 7,
  NOTA_DEBITO_C: 12,
};

// Tipos de documento
export const DOCUMENTO_TIPOS = {
  DNI: 96,
  CUIT: 80,
  CUIL: 86,
  PASAPORTE: 94,
  CONSUMIDOR_FINAL: 99,
};

// Conceptos
export const CONCEPTOS = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3,
};

// Condiciones IVA
export const CONDICIONES_IVA = {
  RESPONSABLE_INSCRIPTO: 1,
  MONOTRIBUTISTA: 6,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
};

// ============================================
// HELPERS
// ============================================

/**
 * Realiza un request a la API de Arca
 */
async function arcaRequest(endpoint, method = "POST", body = null) {
  if (!ARCA_API_KEY || !ARCA_CUIT) {
    throw new Error("Faltan credenciales de Arca (ARCA_API_KEY, ARCA_CUIT)");
  }

  const url = `${ARCA_API_URL}${endpoint}`;
  
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ARCA_API_KEY}`,
      "X-CUIT": ARCA_CUIT,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ARCA_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const text = await response.text();
    let data;
    
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const errorMsg = data?.message || data?.error || text || "Error desconocido";
      throw new Error(`Arca API ${response.status}: ${errorMsg}`);
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    
    if (err.name === "AbortError") {
      throw new Error("Timeout en request a Arca");
    }
    
    throw err;
  }
}

/**
 * Valida y formatea un CUIT/CUIL
 */
function formatCUIT(cuit) {
  const digits = String(cuit || "").replace(/\D/g, "");
  if (digits.length !== 11) return null;
  return digits;
}

/**
 * Calcula hash idempotente para una factura
 */
function computeInvoiceHash(data) {
  const key = JSON.stringify({
    type: data.tipo_comprobante,
    cuit: data.cuit_cliente,
    amount: data.importe_total,
    ref: data.referencia_interna,
  });
  return crypto.createHash("sha256").update(key).digest("hex");
}

// ============================================
// FUNCIONES PRINCIPALES
// ============================================

/**
 * Genera una factura electrónica
 * 
 * @param {Object} params
 * @param {number} params.tipo_comprobante - Tipo de comprobante (usar COMPROBANTE_TIPOS)
 * @param {number} params.concepto - Concepto (usar CONCEPTOS)
 * @param {string} params.cuit_cliente - CUIT del cliente
 * @param {number} params.tipo_doc_cliente - Tipo de documento (usar DOCUMENTO_TIPOS)
 * @param {string} params.doc_cliente - Número de documento
 * @param {string} params.razon_social - Razón social del cliente
 * @param {string} params.domicilio - Domicilio fiscal
 * @param {number} params.condicion_iva - Condición IVA (usar CONDICIONES_IVA)
 * @param {Array} params.items - Items de la factura [{descripcion, cantidad, precio_unitario, alicuota_iva}]
 * @param {number} params.importe_total - Importe total
 * @param {number} params.importe_neto - Importe neto (sin IVA)
 * @param {number} params.importe_iva - Importe IVA
 * @param {string} params.referencia_interna - Referencia interna (ej: appointment_id)
 * @param {string} params.observaciones - Observaciones opcionales
 * 
 * @returns {Object} { cae, vto_cae, numero, tipo_comprobante, punto_venta, fecha_emision }
 */
export async function generarFactura(params) {
  try {
    // Validaciones básicas
    if (!params.tipo_comprobante) {
      throw new Error("Falta tipo de comprobante");
    }
    
    if (!params.items || !Array.isArray(params.items) || params.items.length === 0) {
      throw new Error("Debe incluir al menos un item");
    }

    // Formatear CUIT si viene
    const cuitCliente = params.cuit_cliente 
      ? formatCUIT(params.cuit_cliente)
      : null;

    // Construir payload según formato de Arca
    const payload = {
      punto_venta: Number(ARCA_PUNTO_VENTA),
      tipo_comprobante: Number(params.tipo_comprobante),
      concepto: Number(params.concepto || CONCEPTOS.SERVICIOS),
      
      // Cliente
      cliente: {
        tipo_documento: Number(params.tipo_doc_cliente || DOCUMENTO_TIPOS.DNI),
        documento: String(params.doc_cliente || ""),
        razon_social: String(params.razon_social || "Consumidor Final"),
        domicilio: String(params.domicilio || ""),
        condicion_iva: Number(params.condicion_iva || CONDICIONES_IVA.CONSUMIDOR_FINAL),
        ...(cuitCliente ? { cuit: cuitCliente } : {}),
      },

      // Items
      items: params.items.map((item) => ({
        descripcion: String(item.descripcion).slice(0, 200),
        cantidad: Number(item.cantidad || 1),
        precio_unitario: Number(item.precio_unitario || 0),
        alicuota_iva: Number(item.alicuota_iva || 21), // 21% por defecto
        ...(item.codigo ? { codigo: String(item.codigo) } : {}),
      })),

      // Totales
      importe_total: Number(params.importe_total || 0),
      importe_neto: Number(params.importe_neto || 0),
      importe_iva: Number(params.importe_iva || 0),

      // Metadata
      ...(params.referencia_interna ? { 
        referencia_interna: String(params.referencia_interna) 
      } : {}),
      ...(params.observaciones ? { 
        observaciones: String(params.observaciones).slice(0, 500) 
      } : {}),
    };

    // Request a Arca
    const response = await arcaRequest("/facturas", "POST", payload);

    // Parsear respuesta
    return {
      success: true,
      cae: response.cae,
      vto_cae: response.vencimiento_cae,
      numero: response.numero_comprobante,
      tipo_comprobante: response.tipo_comprobante,
      punto_venta: response.punto_venta,
      fecha_emision: response.fecha_emision,
      pdf_url: response.pdf_url || null,
      xml_url: response.xml_url || null,
      hash: computeInvoiceHash(params),
    };
  } catch (err) {
    console.error("[ARCA] Error generando factura:", err.message);
    throw new Error(`Error al generar factura: ${err.message}`);
  }
}

/**
 * Consulta el estado de una factura por CAE
 */
export async function consultarFactura(cae) {
  try {
    const response = await arcaRequest(`/facturas/${cae}`, "GET");
    return response;
  } catch (err) {
    console.error("[ARCA] Error consultando factura:", err.message);
    throw err;
  }
}

/**
 * Genera una nota de crédito
 */
export async function generarNotaCredito(params) {
  try {
    // Similar a generarFactura pero con tipo de comprobante de nota de crédito
    const tipo = params.tipo_comprobante_original === COMPROBANTE_TIPOS.FACTURA_A
      ? COMPROBANTE_TIPOS.NOTA_CREDITO_A
      : params.tipo_comprobante_original === COMPROBANTE_TIPOS.FACTURA_B
      ? COMPROBANTE_TIPOS.NOTA_CREDITO_B
      : COMPROBANTE_TIPOS.NOTA_CREDITO_C;

    const payload = {
      ...params,
      tipo_comprobante: tipo,
      comprobante_asociado: {
        tipo: params.tipo_comprobante_original,
        punto_venta: params.punto_venta_original,
        numero: params.numero_original,
      },
    };

    return generarFactura(payload);
  } catch (err) {
    console.error("[ARCA] Error generando nota de crédito:", err.message);
    throw err;
  }
}

/**
 * Obtiene el próximo número de comprobante disponible
 */
export async function obtenerProximoNumero(tipoComprobante) {
  try {
    const response = await arcaRequest(
      `/comprobantes/proximo-numero?tipo=${tipoComprobante}&punto_venta=${ARCA_PUNTO_VENTA}`,
      "GET"
    );
    return response.proximo_numero || 1;
  } catch (err) {
    console.error("[ARCA] Error obteniendo próximo número:", err.message);
    return 1;
  }
}

/**
 * Verifica la conexión con Arca
 */
export async function verificarConexion() {
  try {
    const response = await arcaRequest("/health", "GET");
    return { ok: true, ...response };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================
// HELPERS DE NEGOCIO
// ============================================

/**
 * Calcula IVA y totales para un monto
 */
export function calcularIVA(montoNeto, alicuota = 21) {
  const iva = Math.round((montoNeto * alicuota) / 100 * 100) / 100;
  const total = Math.round((montoNeto + iva) * 100) / 100;
  
  return {
    neto: montoNeto,
    iva,
    total,
  };
}

/**
 * Determina el tipo de comprobante según condición IVA del cliente
 */
export function determinarTipoComprobante(condicionIvaCliente) {
  switch (condicionIvaCliente) {
    case CONDICIONES_IVA.RESPONSABLE_INSCRIPTO:
      return COMPROBANTE_TIPOS.FACTURA_A;
    case CONDICIONES_IVA.MONOTRIBUTISTA:
      return COMPROBANTE_TIPOS.FACTURA_B;
    case CONDICIONES_IVA.CONSUMIDOR_FINAL:
    case CONDICIONES_IVA.EXENTO:
    default:
      return COMPROBANTE_TIPOS.FACTURA_B; // o C según tu caso
  }
}

/**
 * Valida que los datos del cliente sean suficientes para facturar
 */
export function validarDatosFacturacion(cliente) {
  const errors = [];

  if (!cliente.razon_social && !cliente.nombre) {
    errors.push("Falta razón social o nombre del cliente");
  }

  if (!cliente.documento && !cliente.cuit) {
    errors.push("Falta documento o CUIT del cliente");
  }

  if (cliente.condicion_iva === CONDICIONES_IVA.RESPONSABLE_INSCRIPTO) {
    if (!cliente.cuit || !formatCUIT(cliente.cuit)) {
      errors.push("Responsables inscriptos deben tener CUIT válido");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}