// src/helpers/parseDay.js
export function parseDay(txt) {
  const t = (txt || "").trim().toLowerCase();
  const today = new Date(); today.setHours(0,0,0,0);
  if (t === "hoy") return today.toISOString().slice(0,10);
  if (t === "mañana" || t === "manana") {
    const d = new Date(today.getTime() + 86400000);
    return d.toISOString().slice(0,10);
  }
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const [_, dd, MM] = m;
  const y = today.getFullYear();
  return `${y}-${String(MM).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
}
