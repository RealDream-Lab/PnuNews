import mysql from 'mysql2/promise';

export function createPool(config) {
  const pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+00:00',
    namedPlaceholders: false,
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
}
