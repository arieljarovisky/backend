import { createPool } from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

export const pool = createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  decimalNumbers: true,
  connectionLimit: 10,
  timezone: "-03:00",
  dateStrings: true,  // ✅ AGREGAR: Esto evita que mysql2 convierta a Date
});
