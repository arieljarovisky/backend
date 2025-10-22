// src/helpers/dateValidation.js

/**
 * Valida que una fecha/hora no sea pasada
 * @param {string|Date} datetime - Fecha en formato "YYYY-MM-DD HH:MM:SS" o Date
 * @returns {boolean}
 */
export function isPastDateTime(datetime) {
    const now = new Date();
    const target = typeof datetime === 'string'
        ? new Date(datetime.replace(' ', 'T'))
        : datetime;

    if (isNaN(target.getTime())) return true; // Fecha inválida = considerar pasada

    return target <= now;
}

/**
 * Valida que una fecha esté dentro del rango permitido (hoy + maxDays)
 * @param {string|Date} datetime 
 * @param {number} maxDays - Días máximos hacia adelante (default: 90)
 * @returns {boolean}
 */
export function isWithinAllowedRange(datetime, maxDays = 90) {
    const target = typeof datetime === 'string'
        ? new Date(datetime.replace(' ', 'T'))
        : datetime;

    if (isNaN(target.getTime())) return false;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + maxDays);

    return target >= today && target <= maxDate;
}

/**
 * Valida que la fecha sea hábil (lunes a sábado, si querés)
 * @param {string|Date} datetime 
 * @returns {boolean}
 */
export function isBusinessDay(datetime) {
    const target = typeof datetime === 'string'
        ? new Date(datetime.replace(' ', 'T'))
        : datetime;

    const day = target.getDay(); // 0=Domingo, 6=Sábado
    return day >= 1 && day <= 6; // Lunes-Sábado (ajustá según tu negocio)
}

/**
 * Validación completa para turnos
 * @param {string} startsAt - Formato "YYYY-MM-DD HH:MM:SS"
 * @throws {Error} si la validación falla
 */
export function validateAppointmentDate(mysqlDateTime) {
    // mysqlDateTime: "YYYY-MM-DD HH:MM:SS"
    const d = new Date(mysqlDateTime.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) {
        throw new Error("Fecha/hora inválida");
    }

    // No permitir fechas en el pasado (con 1 minuto de tolerancia)
    const now = new Date(Date.now() - 60_000);
    if (d < now) {
        throw new Error("La fecha/hora debe ser futura");
    }

    // (Opcional) validar minutos en múltiplos de 5/10/15
    const minutes = d.getMinutes();
    if (minutes % 5 !== 0) throw new Error("La hora debe ser en bloques de 5 minutos");
}