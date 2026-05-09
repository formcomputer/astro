// bin/setup.js — First-run setup for Astro Core
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'astro.json');

console.log('[astro-setup] First-run initialization...');

const config = {
  version: '1.1.0',
  masterSecret: crypto.randomBytes(64).toString('hex'),
  jwtSecret: crypto.randomBytes(64).toString('hex'),
  turnSecret: crypto.randomBytes(32).toString('hex'),
  tagEncryptionKey: crypto.randomBytes(32).toString('hex'),
  adminPassword: crypto.randomBytes(12).toString('base64url'),
  ports: { http: 2000, peerjs: 2001, turn: 3478, turnTLS: 5349 },
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'astro' },
  network: { localIP: '127.0.0.1', publicIP: 'unknown', lastSeen: new Date().toISOString() },
  projects: {},
  createdAt: new Date().toISOString()
};

fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
console.log('[astro-setup] Config written');
console.log(`[astro-setup] Admin password: ${config.adminPassword}`);

fs.writeFileSync(
  path.join(ROOT, 'ADMIN_PASSWORD.txt'),
  `ASTRO — ADMIN CREDENTIALS\n\nUsername: admin\nPassword: ${config.adminPassword}\n\nDelete this file after logging in.\nGenerated: ${new Date().toISOString()}\n`
);
console.log('[astro-setup] Admin credentials written to ADMIN_PASSWORD.txt');

const mysql2 = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function setupMySQL() {
  let conn;
  try {
    conn = await mysql2.createConnection({
      host: config.mysql.host, port: config.mysql.port,
      user: config.mysql.user, password: config.mysql.password
    });
    console.log('[astro-setup] MySQL connected');

    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${config.mysql.database}\``);
    console.log('[astro-setup] Database created');

    // projects
    await conn.execute(`CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL, description TEXT,
      tag_encrypted TEXT NOT NULL, tag_hash VARCHAR(128) UNIQUE NOT NULL,
      status ENUM('pending','approved','revoked') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      metadata JSON
    )`);

    // peers
    await conn.execute(`CREATE TABLE IF NOT EXISTS peers (
      id VARCHAR(128) PRIMARY KEY, project_id VARCHAR(64),
      connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      user_agent TEXT, ip VARCHAR(64),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    // users
    await conn.execute(`CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
      username VARCHAR(64) NOT NULL, email VARCHAR(255),
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user','moderator','admin') DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_login TIMESTAMP, profile JSON,
      UNIQUE KEY unique_user_project (project_id, username),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    // data_store
    await conn.execute(`CREATE TABLE IF NOT EXISTS data_store (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_id VARCHAR(64) NOT NULL, collection VARCHAR(255) NOT NULL,
      doc_id VARCHAR(255) NOT NULL, data JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by VARCHAR(128),
      UNIQUE KEY unique_doc (project_id, collection, doc_id),
      INDEX idx_project_collection (project_id, collection),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    // events
    await conn.execute(`CREATE TABLE IF NOT EXISTS events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      project_id VARCHAR(64) NOT NULL, event_type VARCHAR(64) NOT NULL,
      payload JSON, peer_id VARCHAR(128),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_project_events (project_id, created_at),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    // conversations
    await conn.execute(`CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
      type ENUM('dm','gc','space') NOT NULL, name VARCHAR(255),
      created_by VARCHAR(64), members JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    // messages
    await conn.execute(`CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(64) PRIMARY KEY, conversation_id VARCHAR(64) NOT NULL,
      sender_id VARCHAR(64) NOT NULL, sender_name VARCHAR(64) NOT NULL,
      content TEXT NOT NULL, type VARCHAR(32) DEFAULT 'text',
      read_by JSON, reactions JSON,
      flagged TINYINT(1) DEFAULT 0, flagged_hidden TINYINT(1) DEFAULT 0,
      flag_reason VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conv (conversation_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )`);

    // spaces
    await conn.execute(`CREATE TABLE IF NOT EXISTS spaces (
      id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL, description TEXT,
      owner_id VARCHAR(64) NOT NULL, color VARCHAR(32) DEFAULT '#888888',
      private TINYINT(1) DEFAULT 0, invite_code VARCHAR(16),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_project (project_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`);

    // space_members
    await conn.execute(`CREATE TABLE IF NOT EXISTS space_members (
      space_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL,
      role ENUM('owner','moderator','member') DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (space_id, user_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )`);

    // space_posts
    await conn.execute(`CREATE TABLE IF NOT EXISTS space_posts (
      id VARCHAR(64) PRIMARY KEY, space_id VARCHAR(64) NOT NULL,
      author_id VARCHAR(64) NOT NULL, author_name VARCHAR(64) NOT NULL,
      content TEXT NOT NULL, type ENUM('board','stream') DEFAULT 'stream',
      image LONGTEXT, flames JSON,
      flagged TINYINT(1) DEFAULT 0, flagged_hidden TINYINT(1) DEFAULT 0,
      flag_reason VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_space (space_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )`);

    // user_presence
    await conn.execute(`CREATE TABLE IF NOT EXISTS user_presence (
      user_id VARCHAR(64) NOT NULL, project_id VARCHAR(64) NOT NULL,
      peer_id VARCHAR(128), last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      status ENUM('online','offline') DEFAULT 'online',
      PRIMARY KEY (user_id, project_id)
    )`);

    // flagged_content
    await conn.execute(`CREATE TABLE IF NOT EXISTS flagged_content (
      id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64),
      content_type VARCHAR(32), content_id VARCHAR(64),
      reason VARCHAR(64), reviewed TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reviewed (reviewed)
    )`);

    console.log('[astro-setup] MySQL schema created');

    // Meta project
    const metaTag = crypto.randomBytes(32).toString('hex');
    const metaHash = crypto.createHmac('sha256', config.masterSecret).update('__astro__').digest('hex');
    await conn.execute(
      `INSERT IGNORE INTO projects (id, name, description, tag_encrypted, tag_hash, status) VALUES (?, ?, ?, ?, ?, 'approved')`,
      ['__astro__', 'Astro Core', 'Internal dashboard project', metaTag, metaHash]
    );


    // ── Phase 2 migrations ─────────────────────────────────────────────

    // games
    await conn.execute(`CREATE TABLE IF NOT EXISTS games (
      id VARCHAR(64) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(128) NOT NULL UNIQUE,
      description TEXT,
      genre VARCHAR(64),
      cover_url VARCHAR(512),
      banner_url VARCHAR(512),
      launch_url VARCHAR(512),
      asset_size VARCHAR(32),
      price DECIMAL(10,2) DEFAULT 0.00,
      is_free TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      published TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_published (published),
      INDEX idx_sort (sort_order)
    )`);

    // newsletters
    await conn.execute(`CREATE TABLE IF NOT EXISTS newsletters (
      id VARCHAR(64) PRIMARY KEY,
      subject VARCHAR(512) NOT NULL,
      body_html LONGTEXT,
      author_id VARCHAR(64) NOT NULL,
      author_name VARCHAR(64) NOT NULL,
      published TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      published_at TIMESTAMP NULL,
      INDEX idx_published (published, published_at)
    )`);

    // users: add bio, avatar_url; expand role enum safely
    // ALTER TABLE: ADD COLUMN IF NOT EXISTS (MySQL 8.x syntax)
    try { await conn.execute(`ALTER TABLE users ADD COLUMN bio VARCHAR(280) DEFAULT NULL`); } catch(e) { if (!e.message.includes('Duplicate column')) throw e; }
    try { await conn.execute(`ALTER TABLE users ADD COLUMN avatar_url VARCHAR(512) DEFAULT NULL`); } catch(e) { if (!e.message.includes('Duplicate column')) throw e; }
    // Expand role enum to include writer and moderator (safe — adds values, doesn't remove)
    try {
      await conn.execute(`ALTER TABLE users MODIFY COLUMN role ENUM('user','writer','moderator','admin') DEFAULT 'user'`);
    } catch(e) { console.log('[astro-setup] Role enum already expanded or skipped:', e.message); }

    // CDN directory
    const cdnPath = require('path').join(ROOT, 'data', 'cdn');
    require('fs').mkdirSync(cdnPath, { recursive: true });
    console.log('[astro-setup] CDN directory ready:', cdnPath);

    console.log('[astro-setup] Phase 2 migrations complete.');

    // Admin user
    const adminHash = await bcrypt.hash(config.adminPassword, 12);
    const adminId = crypto.randomUUID();
    await conn.execute(
      `INSERT IGNORE INTO users (id, project_id, username, password_hash, role) VALUES (?, '__astro__', 'admin', ?, 'admin')`,
      [adminId, adminHash]
    );

    console.log('[astro-setup] Admin user created');
    console.log('[astro-setup] Setup complete.');
    process.exit(0);
  } catch (err) {
    console.error('[astro-setup] MySQL error:', err.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

setupMySQL();