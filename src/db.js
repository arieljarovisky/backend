import { createPool } from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

export const pool = createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
 timezone: "-03:00" // guardamos en hora local Argentina
});
