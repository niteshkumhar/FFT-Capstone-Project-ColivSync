// ============================================================
// backend/database.js  -  SQLite setup, tables and demo seed data
// Using 'better-sqlite3' for clean synchronous execution.
// ============================================================
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const dbFile = process.env.COLIVSYNC_DB_PATH
  ? path.resolve(process.env.COLIVSYNC_DB_PATH)
  : path.resolve(__dirname, 'colivsync.db');
const db = new Database(dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- TABLES SETUP ----------
db.exec(`
-- 1. Users, Owners & Admins
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  upi_id TEXT,
  role TEXT NOT NULL DEFAULT 'student', -- 'student', 'owner', 'admin'
  location TEXT,
  property_type TEXT,                   -- 'PG', 'Hostel', 'Flat'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Static monthly caps per category
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL,
  limit_amount REAL NOT NULL,
  UNIQUE(user_id, category)
);

-- 3. Personal expenses (manual entries + ingested UPI transactions)
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'Manual',     -- Manual | Google Pay | PhonePe | Paytm
  upi_ref TEXT UNIQUE,                       -- prevents importing the same UPI txn twice
  date TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Budget breach / warning notifications
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  level TEXT NOT NULL,                       -- warning (>=80%) | breach (>=100%)
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Shared living: flatmates, shared bills, chores
CREATE TABLE IF NOT EXISTS flatmates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  upi_id TEXT
);

CREATE TABLE IF NOT EXISTS shared_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_by INTEGER NOT NULL REFERENCES flatmates(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  frequency TEXT NOT NULL,
  base_assignee INTEGER NOT NULL REFERENCES flatmates(id),
  assignee INTEGER NOT NULL REFERENCES flatmates(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 6. Properties Table (Managed by Owners)
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  type TEXT NOT NULL, -- 'PG', 'Hostel', 'Flat'
  FOREIGN KEY(owner_id) REFERENCES users(id)
);

-- 7. Rooms Table (Single / Shared Options & Rent)
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER,
  room_number TEXT NOT NULL,
  sharing_type TEXT NOT NULL, -- 'Single', 'Shared'
  rent_amount REAL NOT NULL,
  is_available INTEGER DEFAULT 1,
  FOREIGN KEY(property_id) REFERENCES properties(id)
);

-- 8. Bookings / Registrations Table
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  room_id INTEGER,
  amount_paid REAL,
  status TEXT DEFAULT 'Confirmed',
  booked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(room_id) REFERENCES rooms(id)
);

-- 9. Admin side: tenant ledger + announcements, scoped by property location
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL,
  name TEXT NOT NULL,
  room TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  rent_amount REAL NOT NULL,
  rent_status TEXT NOT NULL DEFAULT 'Pending'   -- Paid | Pending
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER,
  location TEXT,
  type TEXT NOT NULL DEFAULT 'Utility',         -- Utility | Maintenance | General
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  resident_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  photo_filename TEXT,
  photo_mime TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function migrateColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  columns.forEach(([column, definition]) => {
    if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  });
}

migrateColumns('users', [
  ['role', "TEXT NOT NULL DEFAULT 'student'"],
  ['location', 'TEXT'],
  ['property_type', 'TEXT'],
  ['password_hash', 'TEXT'],
  ['is_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
  ['created_at', 'DATETIME']
]);
migrateColumns('properties', [
  ['created_at', 'DATETIME'],
  ['description', "TEXT NOT NULL DEFAULT ''"],
  ['is_active', 'INTEGER NOT NULL DEFAULT 1']
]);
migrateColumns('rooms', [['capacity', 'INTEGER NOT NULL DEFAULT 1']]);
migrateColumns('bookings', [
  ['payment_status', "TEXT NOT NULL DEFAULT 'paid'"],
  ['created_at', 'DATETIME']
]);
migrateColumns('broadcasts', [
  ['sender_id', 'INTEGER'],
  ['property_id', 'INTEGER'],
  ['household_id', 'INTEGER'],
  ['expires_at', 'DATETIME']
]);
migrateColumns('alerts', [['user_id', 'INTEGER']]);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rooms_property_number_unique ON rooms(property_id, room_number)');

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    method TEXT NOT NULL DEFAULT 'demo',
    status TEXT NOT NULL DEFAULT 'pending',
    provider_reference TEXT UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS budget_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS households (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL UNIQUE REFERENCES rooms(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS household_members (
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(household_id, user_id),
    UNIQUE(user_id)
  );
  CREATE TABLE IF NOT EXISTS household_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    paid_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS household_chores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    task TEXT NOT NULL,
    frequency TEXT NOT NULL,
    base_assignee_user_id INTEGER NOT NULL REFERENCES users(id),
    assignee_user_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS household_settings (
    household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
    crunch_user_id INTEGER REFERENCES users(id),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS upi_sync_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sync_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rent_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    property_id INTEGER NOT NULL REFERENCES properties(id),
    billing_month TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending',
    updated_by INTEGER REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(booking_id, billing_month)
  );
`);

db.prepare('UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL').run();
db.prepare('UPDATE properties SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL').run();
db.prepare("UPDATE bookings SET payment_status = 'paid' WHERE payment_status IS NULL OR payment_status = ''").run();
db.prepare('UPDATE bookings SET created_at = booked_at WHERE created_at IS NULL').run();
db.prepare("UPDATE bookings SET status = 'confirmed' WHERE status = 'Confirmed'").run();
db.prepare("UPDATE bookings SET status = 'cancelled' WHERE status = 'Cancelled'").run();
db.exec(`
  CREATE INDEX IF NOT EXISTS properties_location_type ON properties(location, type, is_active);
  CREATE INDEX IF NOT EXISTS rooms_property_availability ON rooms(property_id, is_available, sharing_type);
  CREATE INDEX IF NOT EXISTS bookings_room_status_created ON bookings(room_id, status, created_at);
  CREATE INDEX IF NOT EXISTS bookings_user_status ON bookings(user_id, status);
  CREATE INDEX IF NOT EXISTS payments_user_status ON payments(user_id, status);
  CREATE INDEX IF NOT EXISTS budgets_user ON budgets(user_id);
  CREATE INDEX IF NOT EXISTS expenses_user_date ON expenses(user_id, date);
  CREATE INDEX IF NOT EXISTS household_expenses_household ON household_expenses(household_id, created_at);
  CREATE INDEX IF NOT EXISTS rent_records_property_month ON rent_records(property_id, billing_month, status);
  CREATE INDEX IF NOT EXISTS broadcasts_expires_at ON broadcasts(expires_at);
  CREATE INDEX IF NOT EXISTS maintenance_requests_property_status ON maintenance_requests(property_id, status, created_at);
  CREATE INDEX IF NOT EXISTS maintenance_requests_resident ON maintenance_requests(resident_id, created_at);
  CREATE INDEX IF NOT EXISTS maintenance_updates_request ON maintenance_updates(request_id, created_at);
`);

const insertCategory = db.prepare('INSERT OR IGNORE INTO budget_categories (name) VALUES (?)');
['Food', 'Utilities', 'Rent', 'Outings'].forEach(category => insertCategory.run(category));

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

const removeLegacyOwner = db.transaction(userIds => {
  for (const userId of userIds) {
    const properties = db.prepare('SELECT id FROM properties WHERE owner_id = ?').all(userId);
    for (const property of properties) {
      const hasBookings = db.prepare(`
        SELECT 1 FROM bookings b JOIN rooms r ON r.id = b.room_id
        WHERE r.property_id = ? LIMIT 1
      `).get(property.id);
      if (hasBookings) {
        db.prepare('UPDATE properties SET owner_id = NULL, is_active = 0 WHERE id = ?').run(property.id);
        db.prepare('UPDATE rooms SET is_available = 0 WHERE property_id = ?').run(property.id);
        db.prepare('UPDATE broadcasts SET sender_id = NULL WHERE sender_id = ? AND property_id = ?')
          .run(userId, property.id);
        continue;
      }
      db.prepare('DELETE FROM broadcasts WHERE property_id = ? OR sender_id = ?').run(property.id, userId);
      db.prepare(`
        DELETE FROM household_chores WHERE household_id IN (
          SELECT id FROM households WHERE room_id IN (
            SELECT id FROM rooms WHERE property_id = ?
          )
        )
      `).run(property.id);
      db.prepare(`
        DELETE FROM household_expenses WHERE household_id IN (
          SELECT id FROM households WHERE room_id IN (
            SELECT id FROM rooms WHERE property_id = ?
          )
        )
      `).run(property.id);
      db.prepare(`
        DELETE FROM household_members WHERE household_id IN (
          SELECT id FROM households WHERE room_id IN (
            SELECT id FROM rooms WHERE property_id = ?
          )
        )
      `).run(property.id);
      db.prepare(`
        DELETE FROM household_settings WHERE household_id IN (
          SELECT id FROM households WHERE room_id IN (
            SELECT id FROM rooms WHERE property_id = ?
          )
        )
      `).run(property.id);
      db.prepare(`
        DELETE FROM households WHERE room_id IN (
          SELECT id FROM rooms WHERE property_id = ?
        )
      `).run(property.id);
      db.prepare('DELETE FROM rooms WHERE property_id = ?').run(property.id);
      db.prepare('DELETE FROM properties WHERE id = ?').run(property.id);
    }
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM budgets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM expenses WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM alerts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM upi_sync_state WHERE user_id = ?').run(userId);
    db.prepare('UPDATE broadcasts SET sender_id = NULL WHERE sender_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
});

const duplicateAdmins = db.prepare(`
  SELECT id, password_hash FROM users
  WHERE lower(email) = 'admin@colivsync.com' ORDER BY id
`).all();
if (duplicateAdmins.length) {
  const [primaryAdmin, ...duplicateRows] = duplicateAdmins;
  db.prepare("UPDATE users SET name = 'Super Admin', role = 'admin', location = COALESCE(location, 'Bengaluru') WHERE id = ?")
    .run(primaryAdmin.id);
  if (!primaryAdmin.password_hash) {
    const passwordHash = duplicateRows.find(admin => admin.password_hash)?.password_hash;
    if (passwordHash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, primaryAdmin.id);
  }
  const mergeAdmin = db.transaction(() => {
    for (const duplicate of duplicateRows) {
      db.prepare('UPDATE broadcasts SET sender_id = ? WHERE sender_id = ?').run(primaryAdmin.id, duplicate.id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(duplicate.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(duplicate.id);
    }
  });
  mergeAdmin();
}

removeLegacyOwner(db.prepare(`
  SELECT id FROM users WHERE lower(email) = 'ramesh@owner.com'
`).all().map(owner => owner.id));

db.prepare(`
  DELETE FROM users WHERE lower(email) = 'you@example.com'
    AND NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.user_id = users.id)
`).run();
db.prepare(`
  DELETE FROM auth_sessions WHERE user_id IN (
    SELECT id FROM users WHERE lower(email) = 'you@example.com'
  )
`).run();

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_ci
  ON users(lower(email)) WHERE email IS NOT NULL AND trim(email) <> '';
`);

const isProduction = process.env.NODE_ENV === 'production';
const demoAdminPassword = process.env.COLIVSYNC_ADMIN_PASSWORD || (isProduction ? null : 'Admin@123');
if (demoAdminPassword && demoAdminPassword.length < 8) {
  throw new Error('Configured admin password must be at least 8 characters long.');
}
if (!db.prepare("SELECT 1 FROM users WHERE lower(email) = 'admin@colivsync.com'").get()) {
  db.prepare(`
    INSERT INTO users (name, email, role, location, created_at)
    VALUES ('Super Admin', 'admin@colivsync.com', 'admin', 'Bengaluru', CURRENT_TIMESTAMP)
  `).run();
}
if (demoAdminPassword) {
  db.prepare(`
    UPDATE users SET password_hash = ?
    WHERE lower(email) = 'admin@colivsync.com' AND role = 'admin' AND password_hash IS NULL
  `).run(hashPassword(demoAdminPassword));
}

const insertDefaultBudget = db.prepare(`
  INSERT OR IGNORE INTO budgets (user_id, category, limit_amount)
  SELECT ?, name, CASE name WHEN 'Food' THEN 5000 WHEN 'Utilities' THEN 2000
    WHEN 'Rent' THEN 12000 WHEN 'Outings' THEN 1500 ELSE 2000 END
  FROM budget_categories WHERE is_active = 1
`);
db.prepare("SELECT id FROM users WHERE role = 'student'").all()
  .forEach(user => insertDefaultBudget.run(user.id));

module.exports = db;