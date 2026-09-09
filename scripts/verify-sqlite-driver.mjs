import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sqlite3 from "sqlite3";

function openDatabase(filePath) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, (error) => {
      if (error) reject(error);
      else resolve(database);
    });
  });
}

function exec(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => error ? reject(error) : resolve());
  });
}

function get(database, sql) {
  return new Promise((resolve, reject) => {
    database.get(sql, (error, row) => error ? reject(error) : resolve(row));
  });
}

function closeDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve());
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-sqlite-driver-"));
const databasePath = path.join(root, "probe.sqlite");
try {
  const database = await openDatabase(databasePath);
  try {
    await exec(database, `
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)) STRICT;
      BEGIN IMMEDIATE;
      INSERT INTO parent (id) VALUES (1);
      INSERT INTO child (id, parent_id) VALUES (1, 1);
      COMMIT;
    `);
    const row = await get(database, "SELECT count(*) AS count FROM child");
    if (row?.count !== 1) {
      throw new Error(`unexpected SQLite smoke-test row count: ${String(row?.count)}`);
    }
  } finally {
    await closeDatabase(database);
  }
  console.log(JSON.stringify({
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sqlite: sqlite3.VERSION,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
