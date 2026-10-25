const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const SESSION_DAYS = 7;
const PROPERTY_TYPES = ['PG', 'Hostel', 'Flat'];
const SHARING_TYPES = ['Single', 'Shared'];
const MAINTENANCE_CATEGORIES = ['Plumbing', 'Electrical', 'Appliances', 'Cleaning', 'Other'];
const MAINTENANCE_STATUSES = ['open', 'in_progress', 'resolved'];
const MAINTENANCE_PHOTO_LIMIT = 1024 * 1024;
const maintenanceUploadDirectory = process.env.COLIVSYNC_UPLOAD_DIR
  ? path.resolve(process.env.COLIVSYNC_UPLOAD_DIR)
  : path.join(__dirname, 'uploads', 'maintenance');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const sendError = (res, status, message) => res.status(status).json({ success: false, message });
const cleanText = value => typeof value === 'string' ? value.trim() : '';
const announcementExpiry = value => value === undefined || value === null || value === '' ? null : Number(value);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 128;
const passwordParts = value => {
  const [saltHex, hashHex] = String(value || '').split(':');
  if (!saltHex || !hashHex) return null;
  return { salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
};
const hashPassword = password => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
};
const verifyPassword = (password, savedHash) => {
  const parts = passwordParts(savedHash);
  if (!parts || parts.hash.length !== 64) return false;
  const candidate = crypto.scryptSync(password, parts.salt, parts.hash.length);
  return crypto.timingSafeEqual(candidate, parts.hash);
};
const safeUser = user => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  location: user.location,
  property_type: user.property_type
});

db.prepare(`
  DELETE FROM broadcasts
  WHERE household_id IS NOT NULL
    AND (message LIKE '% enabled exam crunch mode.%'
      OR message LIKE '% turned off exam crunch mode.%')
`).run();

function expirePendingBookings() {
  db.transaction(() => {
    db.prepare(`
      UPDATE bookings SET status = 'cancelled', payment_status = 'expired'
      WHERE status = 'pending_payment' AND created_at <= datetime('now', '-15 minutes')
    `).run();
    db.prepare(`
      UPDATE payments SET status = 'expired'
      WHERE status = 'pending' AND booking_id IN (
        SELECT id FROM bookings WHERE status = 'cancelled' AND payment_status = 'expired'
      )
    `).run();
  })();
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare(`
    INSERT INTO auth_sessions (user_id, token_hash, expires_at)
    VALUES (?, ?, datetime('now', ?))
  `).run(userId, tokenHash, `+${SESSION_DAYS} days`);
  return token;
}

function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return sendError(res, 401, 'Sign in to continue.');
  const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
  const user = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.location, u.property_type
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
  `).get(tokenHash);
  if (!user) return sendError(res, 401, 'Your session has expired. Please sign in again.');
  req.user = user;
  req.tokenHash = tokenHash;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return sendError(res, 403, 'You do not have permission to perform this action.');
    next();
  };
}

function ensureDemoSession(userId) {
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
  return createSession(userId);
}

function updateHouseholdChoreAssignments(householdId, crunchUserId, rebalance = false) {
  const members = db.prepare(`
    SELECT user_id FROM household_members WHERE household_id = ? ORDER BY joined_at, user_id
  `).all(householdId).map(member => member.user_id);
  const chores = db.prepare(`
    SELECT id, base_assignee_user_id FROM household_chores WHERE household_id = ? ORDER BY id
  `).all(householdId);
  const update = db.prepare(`
    UPDATE household_chores SET base_assignee_user_id = ?, assignee_user_id = ? WHERE id = ?
  `);
  const helpers = members.filter(id => id !== crunchUserId);
  let reassigned = 0;

  chores.forEach((chore, index) => {
    const baseAssignee = rebalance
      ? members[index % members.length]
      : chore.base_assignee_user_id;
    const assignee = crunchUserId && baseAssignee === crunchUserId && helpers.length
      ? helpers[reassigned++ % helpers.length]
      : baseAssignee;
    update.run(baseAssignee, assignee, chore.id);
  });
}

db.transaction(() => {
  const unbalancedHouseholds = db.prepare(`
    SELECT h.id, hs.crunch_user_id
    FROM households h JOIN household_settings hs ON hs.household_id = h.id
    WHERE (SELECT COUNT(*) FROM household_members hm WHERE hm.household_id = h.id) > 1
      AND (SELECT COUNT(DISTINCT base_assignee_user_id) FROM household_chores c
        WHERE c.household_id = h.id) = 1
  `).all();
  unbalancedHouseholds.forEach(household => {
    updateHouseholdChoreAssignments(household.id, household.crunch_user_id, true);
  });
})();

function createStudentDefaults(userId, roomId) {
  db.prepare(`
    INSERT OR IGNORE INTO budgets (user_id, category, limit_amount)
    SELECT ?, name, CASE name WHEN 'Food' THEN 5000 WHEN 'Utilities' THEN 2000
      WHEN 'Rent' THEN 12000 ELSE 1500 END
    FROM budget_categories WHERE is_active = 1
  `).run(userId);
  const room = db.prepare('SELECT sharing_type FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.sharing_type !== 'Shared') return;

  const household = db.prepare('INSERT OR IGNORE INTO households (room_id) VALUES (?)').run(roomId);
  const householdId = db.prepare('SELECT id FROM households WHERE room_id = ?').get(roomId).id;
  db.prepare('INSERT OR IGNORE INTO household_members (household_id, user_id) VALUES (?, ?)').run(householdId, userId);
  db.prepare('INSERT OR IGNORE INTO household_settings (household_id) VALUES (?)').run(householdId);

  const choreCount = db.prepare('SELECT COUNT(*) AS count FROM household_chores WHERE household_id = ?').get(householdId).count;
  if (choreCount === 0) {
    const addChore = db.prepare(`
      INSERT INTO household_chores
        (household_id, task, frequency, base_assignee_user_id, assignee_user_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    [
      ['Kitchen cleaning', 'Daily'],
      ['Take out trash', 'Daily'],
      ['Bathroom cleaning', 'Weekly'],
      ['Grocery run', 'Weekly'],
      ['Sweep and mop', 'Weekly']
    ].forEach(([task, frequency]) => addChore.run(householdId, task, frequency, userId, userId));
  }
  const crunchUserId = db.prepare('SELECT crunch_user_id FROM household_settings WHERE household_id = ?')
    .get(householdId).crunch_user_id;
  updateHouseholdChoreAssignments(householdId, crunchUserId, true);
}

app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ok' }));

app.get('/api/public/overview', (_req, res) => {
  const stats = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS properties,
      COUNT(DISTINCT p.location) AS locations,
      COUNT(DISTINCT r.id) AS room_options,
      COALESCE(SUM(MAX(0, r.capacity - (
        SELECT COUNT(*) FROM bookings b WHERE b.room_id = r.id AND (
          b.status = 'confirmed' OR
          (b.status = 'pending_payment' AND b.created_at > datetime('now', '-15 minutes'))
        )
      ))), 0) AS available_beds
    FROM properties p LEFT JOIN rooms r ON r.property_id = p.id AND r.is_available = 1
    WHERE p.is_active = 1 AND (p.owner_id IS NULL OR EXISTS (
      SELECT 1 FROM users owner WHERE owner.id = p.owner_id AND owner.is_active = 1
    ))
  `).get();
  res.json({ success: true, stats });
});

app.get('/api/locations', (_req, res) => {
  const locations = db.prepare(`
    SELECT DISTINCT p.location FROM properties p
    LEFT JOIN users owner ON owner.id = p.owner_id
    WHERE p.location IS NOT NULL AND trim(p.location) <> ''
      AND (p.owner_id IS NULL OR owner.is_active = 1)
    ORDER BY p.location COLLATE NOCASE
  `).all().map(row => row.location);
  res.json({ success: true, data: locations });
});

app.get('/api/properties', (req, res) => {
  expirePendingBookings();
  const location = cleanText(req.query.location);
  const type = cleanText(req.query.type);
  const sharing = cleanText(req.query.sharing);
  if (type && !PROPERTY_TYPES.includes(type)) return sendError(res, 400, 'Choose a valid property type.');
  if (sharing && !SHARING_TYPES.includes(sharing)) return sendError(res, 400, 'Choose Single or Shared room options.');

  const filters = [
    'p.is_active = 1',
    'r.is_available = 1',
    "(p.owner_id IS NULL OR EXISTS (SELECT 1 FROM users owner WHERE owner.id = p.owner_id AND owner.is_active = 1))"
  ];
  const params = [];
  if (location) { filters.push('p.location LIKE ?'); params.push(`%${location}%`); }
  if (type) { filters.push('p.type = ?'); params.push(type); }
  if (sharing) { filters.push('r.sharing_type = ?'); params.push(sharing); }
  const rows = db.prepare(`
    SELECT p.id AS property_id, p.name AS property_name, p.location, p.type,
      p.description, r.id AS room_id, r.room_number, r.sharing_type,
      r.rent_amount, r.capacity,
      r.capacity - (SELECT COUNT(*) FROM bookings b
        WHERE b.room_id = r.id AND (
          b.status = 'confirmed' OR
          (b.status = 'pending_payment' AND b.created_at > datetime('now', '-15 minutes'))
        )) AS available_beds
    FROM properties p JOIN rooms r ON r.property_id = p.id
    WHERE ${filters.join(' AND ')}
      AND r.capacity > (SELECT COUNT(*) FROM bookings b
        WHERE b.room_id = r.id AND (
          b.status = 'confirmed' OR
          (b.status = 'pending_payment' AND b.created_at > datetime('now', '-15 minutes'))
        ))
    ORDER BY p.name COLLATE NOCASE, r.rent_amount, r.room_number COLLATE NOCASE
  `).all(...params);
  res.json({ success: true, data: rows });
});

app.get('/api/properties/:id/rooms', (req, res) => {
  expirePendingBookings();
  const propertyId = Number(req.params.id);
  const sharing = cleanText(req.query.sharing);
  if (!Number.isSafeInteger(propertyId) || propertyId < 1) return sendError(res, 400, 'Choose a valid property.');
  if (sharing && !SHARING_TYPES.includes(sharing)) return sendError(res, 400, 'Choose Single or Shared room options.');
  const rooms = db.prepare(`
    SELECT r.id AS room_id, r.room_number, r.sharing_type, r.rent_amount, r.capacity,
      r.capacity - (SELECT COUNT(*) FROM bookings b
        WHERE b.room_id = r.id AND (
          b.status = 'confirmed' OR
          (b.status = 'pending_payment' AND b.created_at > datetime('now', '-15 minutes'))
        )) AS available_beds
    FROM rooms r JOIN properties p ON p.id = r.property_id
    WHERE p.id = ? AND p.is_active = 1 AND r.is_available = 1
      AND (p.owner_id IS NULL OR EXISTS (
        SELECT 1 FROM users owner WHERE owner.id = p.owner_id AND owner.is_active = 1
      ))
      AND (? = '' OR r.sharing_type = ?)
      AND r.capacity > (SELECT COUNT(*) FROM bookings b
        WHERE b.room_id = r.id AND (
          b.status = 'confirmed' OR
          (b.status = 'pending_payment' AND b.created_at > datetime('now', '-15 minutes'))
        ))
    ORDER BY r.rent_amount, r.room_number COLLATE NOCASE
  `).all(propertyId, sharing, sharing);
  res.json({ success: true, data: rooms });
});

app.post('/api/register/tenant', (req, res) => {
  expirePendingBookings();
  const name = cleanText(req.body.name);
  const email = cleanText(req.body.email).toLowerCase();
  const password = req.body.password;
  const roomId = Number(req.body.room_id);
  if (name.length < 2 || name.length > 100 || !validEmail(email) || !validPassword(password) ||
      !Number.isSafeInteger(roomId) || roomId < 1) {
    return sendError(res, 400, 'Enter your name, a valid email, a password of at least 8 characters, and an available room.');
  }

  try {
    const register = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email)) {
        const error = new Error('This email is already registered. Sign in or use another email.');
        error.statusCode = 409;
        throw error;
      }
      const room = db.prepare(`
        SELECT r.id, r.rent_amount, r.capacity, p.location, p.type
        FROM rooms r JOIN properties p ON p.id = r.property_id
        WHERE r.id = ? AND r.is_available = 1 AND p.is_active = 1
          AND (p.owner_id IS NULL OR EXISTS (
            SELECT 1 FROM users owner WHERE owner.id = p.owner_id AND owner.is_active = 1
          ))
          AND r.capacity > (SELECT COUNT(*) FROM bookings b
            WHERE b.room_id = r.id AND (
              b.status = 'confirmed' OR
              (b.status = 'pending_payment' AND b.created_at > datetime('now', '-15 minutes'))
            ))
      `).get(roomId);
      if (!room) {
        const error = new Error('That room is no longer available. Please choose another room.');
        error.statusCode = 409;
        throw error;
      }
      const userResult = db.prepare(`
        INSERT INTO users (name, email, role, location, property_type, password_hash)
        VALUES (?, ?, 'student', ?, ?, ?)
      `).run(name, email, room.location, room.type, hashPassword(password));
      const bookingResult = db.prepare(`
        INSERT INTO bookings (user_id, room_id, amount_paid, status, payment_status, created_at)
        VALUES (?, ?, 0, 'pending_payment', 'pending', CURRENT_TIMESTAMP)
      `).run(userResult.lastInsertRowid, roomId);
      const paymentResult = db.prepare(`
        INSERT INTO payments (booking_id, user_id, amount, method, status)
        VALUES (?, ?, ?, 'colivsync_demo', 'pending')
      `).run(bookingResult.lastInsertRowid, userResult.lastInsertRowid, room.rent_amount);
      createStudentDefaults(userResult.lastInsertRowid, roomId);
      return { userId: userResult.lastInsertRowid, bookingId: bookingResult.lastInsertRowid, paymentId: paymentResult.lastInsertRowid, amount: room.rent_amount };
    });
    const result = register();
    const user = db.prepare('SELECT id, name, email, role, location, property_type FROM users WHERE id = ?').get(result.userId);
    const token = ensureDemoSession(result.userId);
    res.status(201).json({
      success: true,
      message: 'Your room is reserved for 15 minutes. Complete the demo payment to confirm your booking.',
      token,
      user,
      booking_id: result.bookingId,
      payment: { id: result.paymentId, amount: result.amount, currency: 'INR', status: 'pending', mode: 'simulated' }
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return sendError(res, 409, 'This email is already registered. Sign in or use another email.');
    }
    const status = error.statusCode || 400;
    sendError(res, status, error.statusCode ? error.message : 'Registration could not be completed. Please check your details and try again.');
  }
});

app.post('/api/register/owner', (req, res) => {
  const name = cleanText(req.body.name);
  const email = cleanText(req.body.email).toLowerCase();
  const password = req.body.password;
  const location = cleanText(req.body.location);
  const propertyName = cleanText(req.body.property_name);
  const type = cleanText(req.body.property_type);
  if (name.length < 2 || name.length > 100 || !validEmail(email) || !validPassword(password) ||
      !location || location.length > 120 || !propertyName || propertyName.length > 120 || !PROPERTY_TYPES.includes(type)) {
    return sendError(res, 400, 'Enter valid owner, property, location, email, type, and password details.');
  }
  try {
    const register = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email)) {
        const error = new Error('This email is already registered. Sign in or use another email.');
        error.statusCode = 409;
        throw error;
      }
      const userResult = db.prepare(`
        INSERT INTO users (name, email, role, location, property_type, password_hash)
        VALUES (?, ?, 'owner', ?, ?, ?)
      `).run(name, email, location, type, hashPassword(password));
      const propertyResult = db.prepare(`
        INSERT INTO properties (owner_id, name, location, type, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(userResult.lastInsertRowid, propertyName, location, type, cleanText(req.body.description));
      return { userId: userResult.lastInsertRowid, propertyId: propertyResult.lastInsertRowid };
    });
    const result = register();
    const user = db.prepare('SELECT id, name, email, role, location, property_type FROM users WHERE id = ?').get(result.userId);
    res.status(201).json({ success: true, user, token: ensureDemoSession(result.userId), property_id: result.propertyId });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return sendError(res, 409, 'This email is already registered. Sign in or use another email.');
    }
    const status = error.statusCode || 400;
    sendError(res, status, error.statusCode ? error.message : 'Owner registration could not be completed. Please check your details and try again.');
  }
});

app.post('/api/login', (req, res) => {
  const email = cleanText(req.body.email).toLowerCase();
  const password = req.body.password;
  if (!validEmail(email) || typeof password !== 'string' || !password) return sendError(res, 400, 'Enter your email and password.');
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) return sendError(res, 401, 'Email or password is incorrect.');
  if (!user.is_active) return sendError(res, 403, 'This account is paused. Contact a platform administrator.');
  const token = ensureDemoSession(user.id);
  res.json({ success: true, token, user: safeUser(user) });
});

app.get('/api/me', authenticate, (req, res) => res.json({ success: true, user: req.user }));

app.post('/api/logout', authenticate, (req, res) => {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(req.tokenHash);
  res.json({ success: true });
});

app.get('/api/me/dashboard', authenticate, requireRole('student'), (req, res) => {
  db.prepare("DELETE FROM broadcasts WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").run();
  const booking = db.prepare(`
    SELECT b.id AS booking_id, b.status, b.payment_status, b.amount_paid, b.booked_at,
      r.room_number, r.sharing_type, r.rent_amount, p.id AS property_id,
      p.name AS property_name, p.location, p.type
    FROM bookings b JOIN rooms r ON r.id = b.room_id
    JOIN properties p ON p.id = r.property_id
    WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 1
  `).get(req.user.id) || null;
  const payments = db.prepare(`
    SELECT id, booking_id, amount, currency, method, status, created_at, paid_at
    FROM payments WHERE user_id = ? ORDER BY id DESC
  `).all(req.user.id);
  const household = householdForUser(req.user.id);
  const announcements = db.prepare(`
    SELECT b.id, b.type, b.message, b.created_at, p.name AS property_name
    FROM broadcasts b LEFT JOIN properties p ON p.id = b.property_id
    WHERE (b.property_id = ? OR
      (b.property_id IS NULL AND (b.location = ? OR b.location = '*')) OR
      b.household_id = ?)
      AND (b.expires_at IS NULL OR b.expires_at > CURRENT_TIMESTAMP)
    ORDER BY b.id DESC LIMIT 20
  `).all(booking ? booking.property_id : -1, req.user.location || '', household ? household.id : -1);
  res.json({ success: true, user: req.user, booking, payments, announcements });
});

app.get('/api/budgets', authenticate, requireRole('student'), (req, res) => {
  const budgets = db.prepare(`
    SELECT bc.name AS category, COALESCE(b.limit_amount, 0) AS limit_amount,
      COALESCE(SUM(e.amount), 0) AS spent
    FROM budget_categories bc
    LEFT JOIN budgets b ON b.category = bc.name AND b.user_id = ?
    LEFT JOIN expenses e ON e.user_id = ? AND e.category = bc.name
      AND e.date >= date('now', 'start of month') AND e.date < date('now', 'start of month', '+1 month')
    WHERE bc.is_active = 1
    GROUP BY bc.id, bc.name, b.limit_amount
    ORDER BY bc.name COLLATE NOCASE
  `).all(req.user.id, req.user.id).map(item => {
    const percent = item.limit_amount ? Math.round(item.spent / item.limit_amount * 100) : 0;
    return { ...item, percent, status: percent >= 100 ? 'breach' : percent >= 80 ? 'warning' : 'ok' };
  });
  res.json({ success: true, data: budgets });
});

app.put('/api/budgets', authenticate, requireRole('student'), (req, res) => {
  const category = cleanText(req.body.category);
  const limit = Number(req.body.limit_amount);
  if (!category || !Number.isFinite(limit) || limit < 1 || limit > 100000000) {
    return sendError(res, 400, 'Choose a valid category and monthly limit.');
  }
  const exists = db.prepare('SELECT 1 FROM budget_categories WHERE name = ? AND is_active = 1').get(category);
  if (!exists) return sendError(res, 400, 'That budget category is not available.');
  db.prepare(`
    INSERT INTO budgets (user_id, category, limit_amount) VALUES (?, ?, ?)
    ON CONFLICT(user_id, category) DO UPDATE SET limit_amount = excluded.limit_amount
  `).run(req.user.id, category, limit);
  res.json({ success: true });
});

app.get('/api/expenses', authenticate, requireRole('student'), (req, res) => {
  const upiOnly = req.query.source === 'UPI';
  const rows = db.prepare(`
    SELECT id, title, amount, category, source, upi_ref, date, created_at
    FROM expenses WHERE user_id = ? AND (? = 0 OR source <> 'Manual')
    ORDER BY date DESC, id DESC LIMIT 250
  `).all(req.user.id, upiOnly ? 1 : 0);
  res.json({ success: true, data: rows });
});

app.post('/api/expenses', authenticate, requireRole('student'), (req, res) => {
  const title = cleanText(req.body.title);
  const amount = Number(req.body.amount);
  const category = cleanText(req.body.category);
  if (!title || title.length > 120 || !Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    return sendError(res, 400, 'Enter an expense description and a valid positive amount.');
  }
  if (!db.prepare('SELECT 1 FROM budget_categories WHERE name = ? AND is_active = 1').get(category)) {
    return sendError(res, 400, 'Choose an available budget category.');
  }
  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO expenses (user_id, title, amount, category, source) VALUES (?, ?, ?, ?, 'Manual')
    `).run(req.user.id, title, amount, category);
    const budget = db.prepare('SELECT limit_amount FROM budgets WHERE user_id = ? AND category = ?').get(req.user.id, category);
    const spent = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses
      WHERE user_id = ? AND category = ?
        AND date >= date('now', 'start of month') AND date < date('now', 'start of month', '+1 month')
    `).get(req.user.id, category).spent;
    let alert = null;
    if (budget && budget.limit_amount > 0) {
      const percent = spent / budget.limit_amount * 100;
      const level = percent >= 100 ? 'breach' : percent >= 80 ? 'warning' : null;
      if (level) {
        const message = level === 'breach'
          ? `${category} is over its monthly budget (${Math.round(percent)}%).`
          : `${category} has reached ${Math.round(percent)}% of its monthly budget.`;
        db.prepare('INSERT INTO alerts (user_id, category, level, message) VALUES (?, ?, ?, ?)')
          .run(req.user.id, category, level, message);
        alert = { category, level, message };
      }
    }
    return { id: result.lastInsertRowid, alert };
  });
  res.status(201).json({ success: true, ...insert() });
});

app.post('/api/upi/sync', authenticate, requireRole('student'), (req, res) => {
  const syncCount = db.prepare(`
    INSERT INTO upi_sync_state (user_id, sync_count) VALUES (?, 1)
    ON CONFLICT(user_id) DO UPDATE SET sync_count = sync_count + 1
    RETURNING sync_count
  `).get(req.user.id).sync_count;
  const transactions = [
    { title: 'Campus cafe', amount: 180 + (syncCount % 4) * 35, category: 'Food', source: 'Google Pay' },
    { title: 'Metro recharge', amount: 250 + (syncCount % 3) * 50, category: 'Utilities', source: 'PhonePe' },
    { title: 'Lunch with friends', amount: 220 + (syncCount % 5) * 25, category: 'Food', source: 'Paytm' }
  ];
  const sync = db.transaction(() => {
    const addExpense = db.prepare(`
      INSERT OR IGNORE INTO expenses (user_id, title, amount, category, source, upi_ref)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let imported = 0;
    transactions.forEach((item, index) => {
      const ref = `COLIVSYNC-MOCK-${req.user.id}-${syncCount}-${index + 1}`;
      imported += addExpense.run(req.user.id, item.title, item.amount, item.category, item.source, ref).changes;
    });
    const alerts = [];
    const budgets = db.prepare('SELECT category, limit_amount FROM budgets WHERE user_id = ?').all(req.user.id);
    budgets.forEach(budget => {
      const spent = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses
        WHERE user_id = ? AND category = ?
          AND date >= date('now', 'start of month') AND date < date('now', 'start of month', '+1 month')
      `).get(req.user.id, budget.category).spent;
      const percent = budget.limit_amount > 0 ? spent / budget.limit_amount * 100 : 0;
      const level = percent >= 100 ? 'breach' : percent >= 80 ? 'warning' : null;
      if (level) {
        const message = level === 'breach'
          ? `${budget.category} is over its monthly budget (${Math.round(percent)}%).`
          : `${budget.category} has reached ${Math.round(percent)}% of its monthly budget.`;
        db.prepare('INSERT INTO alerts (user_id, category, level, message) VALUES (?, ?, ?, ?)')
          .run(req.user.id, budget.category, level, message);
        alerts.push({ category: budget.category, level, message });
      }
    });
    return { imported, alerts };
  });
  res.json({ success: true, ...sync() });
});

app.get('/api/alerts', authenticate, requireRole('student'), (req, res) => {
  const alerts = db.prepare(`
    SELECT id, category, level, message, is_read, created_at
    FROM alerts WHERE user_id = ? ORDER BY id DESC LIMIT 100
  `).all(req.user.id);
  res.json({
    success: true,
    unread: alerts.filter(alert => !alert.is_read).length,
    alerts: alerts.map(alert => ({ ...alert, type: alert.category === 'Household' ? 'household' : 'budget' }))
  });
});

app.post('/api/alerts/read', authenticate, requireRole('student'), (_req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE user_id = ?').run(_req.user.id);
  res.json({ success: true });
});

function householdForUser(userId) {
  return db.prepare(`
    SELECT h.id, h.room_id, hs.crunch_user_id
    FROM household_members hm JOIN households h ON h.id = hm.household_id
    JOIN household_settings hs ON hs.household_id = h.id
    JOIN rooms r ON r.id = h.room_id AND r.sharing_type = 'Shared'
    WHERE hm.user_id = ?
  `).get(userId) || null;
}

app.get('/api/shared', authenticate, requireRole('student'), (req, res) => {
  const household = householdForUser(req.user.id);
  if (!household) return sendError(res, 404, 'No shared household is connected to this account.');
  const members = db.prepare(`
    SELECT u.id, u.name, u.email FROM household_members hm
    JOIN users u ON u.id = hm.user_id WHERE hm.household_id = ? ORDER BY hm.joined_at, u.id
  `).all(household.id);
  const expenses = db.prepare(`
    SELECT e.id, e.title, e.amount, e.paid_by_user_id AS paid_by,
      u.name AS paid_by_name, e.created_at
    FROM household_expenses e JOIN users u ON u.id = e.paid_by_user_id
    WHERE e.household_id = ? ORDER BY e.id DESC
  `).all(household.id);
  const balances = members.map(member => ({ ...member, paid: 0, share: 0, net: 0 }));
  const balanceById = new Map(balances.map(balance => [balance.id, balance]));
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  expenses.forEach(expense => {
    const balance = balanceById.get(expense.paid_by);
    if (balance) balance.paid += expense.amount;
  });
  const share = members.length ? total / members.length : 0;
  balances.forEach(balance => {
    balance.share = share;
    balance.net = balance.paid - share;
  });
  const debtors = balances.filter(balance => balance.net < -0.005).map(balance => ({ ...balance, remaining: -balance.net }));
  const creditors = balances.filter(balance => balance.net > 0.005).map(balance => ({ ...balance, remaining: balance.net }));
  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amount = Math.min(debtors[debtorIndex].remaining, creditors[creditorIndex].remaining);
    transfers.push({ from: debtors[debtorIndex].name, to: creditors[creditorIndex].name, amount: Math.round(amount * 100) / 100 });
    debtors[debtorIndex].remaining -= amount;
    creditors[creditorIndex].remaining -= amount;
    if (debtors[debtorIndex].remaining < 0.005) debtorIndex++;
    if (creditors[creditorIndex].remaining < 0.005) creditorIndex++;
  }
  const chores = db.prepare(`
    SELECT c.id, c.task, c.frequency, c.base_assignee_user_id AS base_assignee,
      base.name AS base_name, c.assignee_user_id AS assignee, current.name AS assignee_name
    FROM household_chores c
    JOIN users base ON base.id = c.base_assignee_user_id
    JOIN users current ON current.id = c.assignee_user_id
    WHERE c.household_id = ? ORDER BY c.id
  `).all(household.id);
  res.json({
    success: true, household_id: household.id, me: req.user.id,
    members, expenses, bills: expenses, total, share, balances, transfers, chores,
    crunch_member: household.crunch_user_id
  });
});

app.post('/api/shared-expenses', authenticate, requireRole('student'), (req, res) => {
  const household = householdForUser(req.user.id);
  if (!household) return sendError(res, 404, 'No shared household is connected to this account.');
  const title = cleanText(req.body.title);
  const amount = Number(req.body.amount);
  const paidBy = Number(req.body.paid_by);
  const isMember = db.prepare('SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?')
    .get(household.id, paidBy);
  if (!title || title.length > 120 || !Number.isFinite(amount) || amount <= 0 ||
      amount > 10000000 || !isMember) {
    return sendError(res, 400, 'Enter a bill name, valid amount, and household member who paid.');
  }
  const result = db.prepare(`
    INSERT INTO household_expenses (household_id, title, amount, paid_by_user_id)
    VALUES (?, ?, ?, ?)
  `).run(household.id, title, amount, paidBy);
  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

app.get('/api/maintenance-requests', authenticate, requireRole('student', 'owner'), (req, res) => {
  const requests = req.user.role === 'owner'
    ? db.prepare(`
      SELECT mr.id, mr.property_id, mr.room_id, mr.resident_id, mr.title, mr.category,
        mr.priority, mr.description, mr.status, mr.created_at, mr.updated_at,
        mr.photo_filename IS NOT NULL AS has_photo, p.name AS property_name,
        r.room_number, resident.name AS resident_name
      FROM maintenance_requests mr
      JOIN properties p ON p.id = mr.property_id
      JOIN rooms r ON r.id = mr.room_id
      JOIN users resident ON resident.id = mr.resident_id
      WHERE p.owner_id = ? ORDER BY
        CASE mr.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        mr.updated_at DESC LIMIT 100
    `).all(req.user.id)
    : db.prepare(`
      SELECT mr.id, mr.property_id, mr.room_id, mr.resident_id, mr.title, mr.category,
        mr.priority, mr.description, mr.status, mr.created_at, mr.updated_at,
        mr.photo_filename IS NOT NULL AS has_photo, p.name AS property_name,
        r.room_number, resident.name AS resident_name
      FROM maintenance_requests mr
      JOIN properties p ON p.id = mr.property_id
      JOIN rooms r ON r.id = mr.room_id
      JOIN users resident ON resident.id = mr.resident_id
      WHERE mr.resident_id = ? ORDER BY mr.updated_at DESC LIMIT 100
    `).all(req.user.id);
  const updatesForRequest = db.prepare(`
    SELECT mu.id, mu.message, mu.created_at, u.id AS user_id, u.name AS user_name, u.role AS user_role
    FROM maintenance_updates mu JOIN users u ON u.id = mu.user_id
    WHERE mu.request_id = ? ORDER BY mu.id
  `);
  res.json({
    success: true,
    data: requests.map(request => ({ ...request, has_photo: Boolean(request.has_photo), updates: updatesForRequest.all(request.id) }))
  });
});

app.post('/api/maintenance-requests', authenticate, requireRole('student'), (req, res) => {
  const title = cleanText(req.body.title);
  const category = cleanText(req.body.category);
  const priority = cleanText(req.body.priority) || 'normal';
  const description = cleanText(req.body.description);
  const photoData = typeof req.body.photo_data === 'string' ? req.body.photo_data : '';
  const photoMime = cleanText(req.body.photo_mime);
  if (!title || title.length > 100 || !MAINTENANCE_CATEGORIES.includes(category) ||
      !['normal', 'high'].includes(priority) || description.length < 5 || description.length > 2000) {
    return sendError(res, 400, 'Enter an issue title, category, and description of 5 to 2,000 characters.');
  }
  const booking = db.prepare(`
    SELECT b.room_id, r.property_id FROM bookings b JOIN rooms r ON r.id = b.room_id
    WHERE b.user_id = ? AND b.status = 'confirmed' ORDER BY b.id DESC LIMIT 1
  `).get(req.user.id);
  if (!booking) return sendError(res, 403, 'A confirmed room booking is required to submit a maintenance request.');

  let photoBuffer = null;
  let extension = '';
  if (photoData || photoMime) {
    const photoTypes = {
      'image/jpeg': { extension: '.jpg', signature: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
      'image/png': { extension: '.png', signature: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
      'image/webp': { extension: '.webp', signature: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' }
    };
    const photoType = photoTypes[photoMime];
    if (!photoData || !photoType || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photoData)) {
      return sendError(res, 400, 'Attach a valid JPEG, PNG, or WebP image.');
    }
    photoBuffer = Buffer.from(photoData, 'base64');
    if (!photoBuffer.length || photoBuffer.length > MAINTENANCE_PHOTO_LIMIT || photoBuffer.toString('base64') !== photoData) {
      return sendError(res, 400, 'Maintenance photos must be no larger than 1 MB.');
    }
    if (!photoType.signature(photoBuffer)) return sendError(res, 400, 'The uploaded image does not match its file type.');
    extension = photoType.extension;
  }

  let photoFilename = null;
  if (photoBuffer) {
    fs.mkdirSync(maintenanceUploadDirectory, { recursive: true });
    photoFilename = `${crypto.randomBytes(24).toString('hex')}${extension}`;
    fs.writeFileSync(path.join(maintenanceUploadDirectory, photoFilename), photoBuffer, { flag: 'wx' });
  }
  try {
    const result = db.prepare(`
      INSERT INTO maintenance_requests
        (property_id, room_id, resident_id, title, category, priority, description, photo_filename, photo_mime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      booking.property_id, booking.room_id, req.user.id,
      title, category, priority, description, photoFilename, photoFilename ? photoMime : null
    );
    res.status(201).json({ success: true, request_id: result.lastInsertRowid });
  } catch (error) {
    if (photoFilename) fs.unlinkSync(path.join(maintenanceUploadDirectory, photoFilename));
    throw error;
  }
});

app.post('/api/maintenance-requests/:id/updates', authenticate, requireRole('student', 'owner'), (req, res) => {
  const requestId = Number(req.params.id);
  const message = cleanText(req.body.message);
  if (!Number.isSafeInteger(requestId) || requestId < 1 || !message || message.length > 2000) {
    return sendError(res, 400, 'Choose a request and enter an update under 2,000 characters.');
  }
  const request = db.prepare(`
    SELECT mr.id FROM maintenance_requests mr
    JOIN properties p ON p.id = mr.property_id
    WHERE mr.id = ? AND (
      (p.owner_id = ? AND ? = 'owner') OR
      (mr.resident_id = ? AND ? = 'student')
    )
  `).get(requestId, req.user.id, req.user.role, req.user.id, req.user.role);
  if (!request) return sendError(res, 404, 'Maintenance request not found for your account.');
  const result = db.prepare(`
    INSERT INTO maintenance_updates (request_id, user_id, message) VALUES (?, ?, ?)
  `).run(requestId, req.user.id, message);
  db.prepare('UPDATE maintenance_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(requestId);
  res.status(201).json({ success: true, update_id: result.lastInsertRowid });
});

app.patch('/api/maintenance-requests/:id', authenticate, requireRole('owner'), (req, res) => {
  const requestId = Number(req.params.id);
  const status = cleanText(req.body.status);
  const message = cleanText(req.body.message);
  if (!Number.isSafeInteger(requestId) || requestId < 1 || !MAINTENANCE_STATUSES.includes(status) || message.length > 2000) {
    return sendError(res, 400, 'Choose a valid request status and an optional update under 2,000 characters.');
  }
  const updateRequest = db.transaction(() => {
    const result = db.prepare(`
      UPDATE maintenance_requests SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND property_id IN (SELECT id FROM properties WHERE owner_id = ?)
    `).run(status, requestId, req.user.id);
    if (!result.changes) return false;
    if (message) {
      db.prepare('INSERT INTO maintenance_updates (request_id, user_id, message) VALUES (?, ?, ?)')
        .run(requestId, req.user.id, message);
    }
    return true;
  });
  if (!updateRequest()) return sendError(res, 404, 'Maintenance request not found for your account.');
  res.json({ success: true });
});

app.get('/api/maintenance-requests/:id/photo', authenticate, requireRole('student', 'owner'), (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isSafeInteger(requestId) || requestId < 1) return sendError(res, 400, 'Choose a valid maintenance request.');
  const request = db.prepare(`
    SELECT mr.photo_filename, mr.photo_mime
    FROM maintenance_requests mr JOIN properties p ON p.id = mr.property_id
    WHERE mr.id = ? AND mr.photo_filename IS NOT NULL AND (
      (p.owner_id = ? AND ? = 'owner') OR
      (mr.resident_id = ? AND ? = 'student')
    )
  `).get(requestId, req.user.id, req.user.role, req.user.id, req.user.role);
  if (!request) return sendError(res, 404, 'Maintenance photo not found for your account.');
  const photoPath = path.join(maintenanceUploadDirectory, request.photo_filename);
  if (!fs.existsSync(photoPath)) return sendError(res, 404, 'The maintenance photo is no longer available.');
  res.set('Cache-Control', 'private, no-store');
  res.type(request.photo_mime).sendFile(photoPath);
});

app.get('/api/chores', authenticate, requireRole('student'), (req, res) => {
  const household = householdForUser(req.user.id);
  if (!household) return sendError(res, 404, 'No shared household is connected to this account.');
  const group = db.prepare(`
    SELECT u.id, u.name FROM household_members hm JOIN users u ON u.id = hm.user_id
    WHERE hm.household_id = ? ORDER BY hm.joined_at, u.id
  `).all(household.id);
  const chores = db.prepare(`
    SELECT c.id, c.task, c.frequency, c.base_assignee_user_id AS base_assignee,
      c.assignee_user_id AS assignee, base.name AS base_name, current.name AS assignee_name
    FROM household_chores c JOIN users base ON base.id = c.base_assignee_user_id
    JOIN users current ON current.id = c.assignee_user_id
    WHERE c.household_id = ? ORDER BY c.id
  `).all(household.id);
  res.json({ success: true, me: req.user.id, members: group, chores, crunch_member: household.crunch_user_id });
});

app.post('/api/crunch', authenticate, requireRole('student'), (req, res) => {
  const household = householdForUser(req.user.id);
  if (!household) return sendError(res, 404, 'No shared household is connected to this account.');
  if (typeof req.body.active !== 'boolean') return sendError(res, 400, 'Choose whether crunch mode should be on or off.');
  const crunchUser = req.body.active ? req.user.id : null;
  if (household.crunch_user_id === crunchUser) {
    return res.json({ success: true, me: req.user.id, crunch_member: crunchUser });
  }
  const setCrunch = db.transaction(() => {
    db.prepare('UPDATE household_settings SET crunch_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE household_id = ?')
      .run(crunchUser, household.id);
    updateHouseholdChoreAssignments(household.id, crunchUser);
    const message = req.body.active
      ? `${req.user.name} is in exam crunch mode. Household chores have been reallocated to you.`
      : `${req.user.name} turned off exam crunch mode. Your household's regular chore rotation is restored.`;
    const notifyMember = db.prepare(`
      INSERT INTO alerts (user_id, category, level, message)
      SELECT user_id, 'Household', 'info', ?
      FROM household_members
      WHERE household_id = ? AND user_id <> ?
    `);
    notifyMember.run(message, household.id, req.user.id);
  });
  setCrunch();
  res.json({ success: true, me: req.user.id, crunch_member: crunchUser });
});

app.post('/api/payments/:id/confirm', authenticate, requireRole('student'), (req, res) => {
  expirePendingBookings();
  const paymentId = Number(req.params.id);
  if (!Number.isSafeInteger(paymentId) || paymentId < 1) return sendError(res, 400, 'Choose a valid payment.');
  try {
    const confirm = db.transaction(() => {
      const payment = db.prepare(`
        SELECT p.*, b.id AS booking_id, b.room_id, b.status AS booking_status,
          r.capacity, property.id AS property_id
        FROM payments p JOIN bookings b ON b.id = p.booking_id
        JOIN rooms r ON r.id = b.room_id
        JOIN properties property ON property.id = r.property_id
        WHERE p.id = ? AND p.user_id = ?
      `).get(paymentId, req.user.id);
      if (!payment) {
        const error = new Error('Payment was not found.');
        error.statusCode = 404;
        throw error;
      }
      if (payment.status === 'simulated_paid') {
        db.prepare(`
          INSERT OR IGNORE INTO rent_records (booking_id, user_id, property_id, billing_month, amount, status)
          VALUES (?, ?, ?, strftime('%Y-%m', 'now'), ?, 'simulated_paid')
        `).run(payment.booking_id, req.user.id, payment.property_id, payment.amount);
        return payment.booking_id;
      }
      if (payment.booking_status !== 'pending_payment') {
        const error = new Error('This room reservation is no longer available. Start a new booking.');
        error.statusCode = 409;
        throw error;
      }
      if (payment.status !== 'pending' ||
          !db.prepare("SELECT 1 FROM bookings WHERE id = ? AND status = 'pending_payment'").get(payment.booking_id)) {
        const error = new Error('Your 15-minute room reservation expired. Please choose a room again.');
        error.statusCode = 409;
        throw error;
      }
      const activeCount = db.prepare(`
        SELECT COUNT(*) AS count FROM bookings
        WHERE room_id = ? AND status = 'confirmed'
      `).get(payment.room_id).count;
      if (activeCount >= payment.capacity) {
        const error = new Error('This room is full. Please choose another available room.');
        error.statusCode = 409;
        throw error;
      }
      db.prepare(`
        UPDATE payments SET status = 'simulated_paid', paid_at = CURRENT_TIMESTAMP,
          provider_reference = ?
        WHERE id = ? AND status = 'pending'
      `).run(`COLIV-DEMO-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, paymentId);
      db.prepare(`
        UPDATE bookings SET status = 'confirmed', payment_status = 'simulated_paid', amount_paid = ?
        WHERE id = ?
      `).run(payment.amount, payment.booking_id);
      db.prepare(`
        INSERT OR IGNORE INTO rent_records (booking_id, user_id, property_id, billing_month, amount, status)
        VALUES (?, ?, ?, strftime('%Y-%m', 'now'), ?, 'simulated_paid')
      `).run(payment.booking_id, req.user.id, payment.property_id, payment.amount);
      return payment.booking_id;
    });
    confirm();
    res.json({ success: true, message: 'Demo payment recorded. No real money was transferred.' });
  } catch (error) {
    sendError(res, error.statusCode || 400, error.statusCode ? error.message : 'Payment could not be confirmed.');
  }
});

app.post('/api/payments/:id/cancel', authenticate, requireRole('student'), (req, res) => {
  const paymentId = Number(req.params.id);
  const cancel = db.transaction(() => {
    const payment = db.prepare(`
      SELECT p.id, p.status, b.id AS booking_id, b.status AS booking_status
      FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.id = ? AND p.user_id = ?
    `).get(paymentId, req.user.id);
    if (!payment) return false;
    if (payment.status === 'pending' && payment.booking_status === 'pending_payment') {
      db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(paymentId);
      db.prepare("UPDATE bookings SET status = 'cancelled', payment_status = 'cancelled' WHERE id = ?").run(payment.booking_id);
    }
    return true;
  });
  if (!Number.isSafeInteger(paymentId) || paymentId < 1 || !cancel()) return sendError(res, 404, 'Payment was not found.');
  res.json({ success: true });
});

app.get('/api/owner/overview', authenticate, requireRole('owner'), (req, res) => {
  expirePendingBookings();
  const properties = db.prepare(`
    SELECT p.id, p.name, p.location, p.type, p.description, p.is_active, p.created_at,
      COUNT(DISTINCT r.id) AS total_rooms,
      COALESCE((SELECT SUM(rooms.capacity) FROM rooms WHERE rooms.property_id = p.id), 0) AS total_beds,
      COUNT(DISTINCT CASE WHEN b.status = 'confirmed' THEN b.id END) AS occupied_beds,
      COUNT(DISTINCT CASE WHEN r.is_available = 1 THEN r.id END) AS listed_rooms
    FROM properties p
    LEFT JOIN rooms r ON r.property_id = p.id
    LEFT JOIN bookings b ON b.room_id = r.id
    WHERE p.owner_id = ?
    GROUP BY p.id ORDER BY p.id DESC
  `).all(req.user.id);
  const tenants = db.prepare(`
    SELECT u.id, u.name, u.email, p.name AS property_name, p.id AS property_id,
      r.room_number, r.sharing_type, r.rent_amount, b.status AS booking_status,
      b.payment_status, b.booked_at, u.is_verified,
      rent.billing_month, rent.status AS rent_status
    FROM bookings b JOIN users u ON u.id = b.user_id
    JOIN rooms r ON r.id = b.room_id JOIN properties p ON p.id = r.property_id
    LEFT JOIN rent_records rent ON rent.id = (
      SELECT rr.id FROM rent_records rr WHERE rr.booking_id = b.id
      ORDER BY rr.billing_month DESC LIMIT 1
    )
    WHERE p.owner_id = ? AND b.status IN ('confirmed', 'pending_payment')
    ORDER BY b.id DESC
  `).all(req.user.id);
  res.json({ success: true, properties, tenants });
});

app.get('/api/owner/rents', authenticate, requireRole('owner'), (req, res) => {
  const records = db.prepare(`
    SELECT rr.id, rr.billing_month, rr.amount, rr.status, rr.updated_at,
      u.name AS tenant_name, u.email AS tenant_email, p.name AS property_name,
      r.room_number, r.sharing_type
    FROM rent_records rr JOIN bookings b ON b.id = rr.booking_id
    JOIN users u ON u.id = rr.user_id JOIN properties p ON p.id = rr.property_id
    JOIN rooms r ON r.id = b.room_id
    WHERE p.owner_id = ? ORDER BY rr.billing_month DESC, rr.id DESC
  `).all(req.user.id);
  res.json({ success: true, data: records });
});

app.patch('/api/owner/rents/:id', authenticate, requireRole('owner'), (req, res) => {
  const rentId = Number(req.params.id);
  const status = cleanText(req.body.status);
  if (!Number.isSafeInteger(rentId) || rentId < 1 || !['pending', 'paid'].includes(status)) {
    return sendError(res, 400, 'Choose a valid rent record and pending or paid status.');
  }
  const result = db.prepare(`
    UPDATE rent_records SET status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND property_id IN (SELECT id FROM properties WHERE owner_id = ?)
  `).run(status, req.user.id, rentId, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Rent record not found for your properties.');
  res.json({ success: true });
});

app.get('/api/owner/rooms', authenticate, requireRole('owner'), (req, res) => {
  expirePendingBookings();
  const rooms = db.prepare(`
    SELECT r.id, r.property_id, p.name AS property_name, p.location, p.type,
      r.room_number, r.sharing_type, r.rent_amount, r.capacity, r.is_available,
      (SELECT COUNT(*) FROM bookings b WHERE b.room_id = r.id AND b.status = 'confirmed') AS occupied_beds
    FROM rooms r JOIN properties p ON p.id = r.property_id
    WHERE p.owner_id = ? ORDER BY p.name COLLATE NOCASE, r.room_number COLLATE NOCASE
  `).all(req.user.id);
  res.json({ success: true, data: rooms });
});

app.post('/api/owner/properties', authenticate, requireRole('owner'), (req, res) => {
  const name = cleanText(req.body.name);
  const location = cleanText(req.body.location);
  const type = cleanText(req.body.type);
  if (!name || name.length > 120 || !location || location.length > 120 || !PROPERTY_TYPES.includes(type)) {
    return sendError(res, 400, 'Enter a property name, location, and valid property type.');
  }
  const result = db.prepare(`
    INSERT INTO properties (owner_id, name, location, type, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, name, location, type, cleanText(req.body.description).slice(0, 1000));
  res.status(201).json({ success: true, property_id: result.lastInsertRowid });
});

app.post('/api/owner/properties/:id/rooms', authenticate, requireRole('owner'), (req, res) => {
  const propertyId = Number(req.params.id);
  const roomNumber = cleanText(req.body.room_number);
  const sharingType = cleanText(req.body.sharing_type);
  const rent = Number(req.body.rent_amount);
  const capacity = Number(req.body.capacity);
  if (!Number.isSafeInteger(propertyId) || propertyId < 1 || !roomNumber || roomNumber.length > 40 ||
      !SHARING_TYPES.includes(sharingType) || !Number.isFinite(rent) || rent < 1 || rent > 10000000 ||
      !Number.isSafeInteger(capacity) || capacity < (sharingType === 'Shared' ? 2 : 1) || capacity > 20 ||
      (sharingType === 'Single' && capacity !== 1)) {
    return sendError(res, 400, 'Enter a valid room number, room type, monthly rent, and capacity.');
  }
  const property = db.prepare('SELECT id FROM properties WHERE id = ? AND owner_id = ?').get(propertyId, req.user.id);
  if (!property) return sendError(res, 404, 'Property not found for your account.');
  try {
    const duplicate = db.prepare(`
      SELECT 1 FROM rooms WHERE property_id = ? AND lower(room_number) = lower(?)
    `).get(propertyId, roomNumber);
    if (duplicate) return sendError(res, 409, 'That room number already exists in this property.');
    const result = db.prepare(`
      INSERT INTO rooms (property_id, room_number, sharing_type, rent_amount, is_available, capacity)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(propertyId, roomNumber, sharingType, rent, capacity);
    res.status(201).json({ success: true, room_id: result.lastInsertRowid });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'That room number already exists in this property.');
    throw error;
  }
});

app.patch('/api/owner/rooms/:id', authenticate, requireRole('owner'), (req, res) => {
  const roomId = Number(req.params.id);
  const isAvailable = req.body.is_available;
  if (!Number.isSafeInteger(roomId) || roomId < 1 || typeof isAvailable !== 'boolean') {
    return sendError(res, 400, 'Choose a valid room and availability setting.');
  }
  const result = db.prepare(`
    UPDATE rooms SET is_available = ?
    WHERE id = ? AND property_id IN (SELECT id FROM properties WHERE owner_id = ?)
  `).run(isAvailable ? 1 : 0, roomId, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Room not found for your account.');
  res.json({ success: true });
});

app.post('/api/owner/announcements', authenticate, requireRole('owner'), (req, res) => {
  const propertyId = Number(req.body.property_id);
  const type = cleanText(req.body.type) || 'General';
  const message = cleanText(req.body.message);
  const expiresInDays = announcementExpiry(req.body.expires_in_days);
  const allowedTypes = ['Utility', 'Maintenance', 'General'];
  if (!Number.isSafeInteger(propertyId) || propertyId < 1 || !allowedTypes.includes(type) || !message || message.length > 1000 ||
      (expiresInDays !== null && ![1, 2].includes(expiresInDays))) {
    return sendError(res, 400, 'Choose a property and announcement type, and enter a message under 1,000 characters.');
  }
  const property = db.prepare('SELECT id, location FROM properties WHERE id = ? AND owner_id = ?').get(propertyId, req.user.id);
  if (!property) return sendError(res, 404, 'Property not found for your account.');
  const result = db.prepare(`
    INSERT INTO broadcasts (sender_id, location, property_id, type, message, expires_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' days') END)
  `).run(req.user.id, property.location, property.id, type, message, expiresInDays, expiresInDays);
  res.status(201).json({ success: true, announcement_id: result.lastInsertRowid });
});

app.get('/api/owner/announcements', authenticate, requireRole('owner'), (req, res) => {
  db.prepare("DELETE FROM broadcasts WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").run();
  const announcements = db.prepare(`
    SELECT b.id, b.property_id, b.location, b.type, b.message, b.created_at, b.expires_at, p.name AS property_name
    FROM broadcasts b LEFT JOIN properties p ON p.id = b.property_id
    WHERE b.sender_id = ? AND (b.expires_at IS NULL OR b.expires_at > CURRENT_TIMESTAMP)
    ORDER BY b.id DESC LIMIT 100
  `).all(req.user.id);
  res.json({ success: true, data: announcements });
});

app.delete('/api/owner/announcements/:id', authenticate, requireRole('owner'), (req, res) => {
  const announcementId = Number(req.params.id);
  if (!Number.isSafeInteger(announcementId) || announcementId < 1) {
    return sendError(res, 400, 'Choose a valid announcement.');
  }
  const result = db.prepare('DELETE FROM broadcasts WHERE id = ? AND sender_id = ?')
    .run(announcementId, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Announcement not found for your account.');
  res.json({ success: true });
});

app.get('/api/admin/overview', authenticate, requireRole('admin'), (_req, res) => {
  expirePendingBookings();
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM properties) AS total_properties,
      (SELECT COUNT(*) FROM properties WHERE type = 'Flat') AS total_flats,
      (SELECT COUNT(*) FROM properties WHERE type = 'PG') AS total_pgs,
      (SELECT COUNT(*) FROM properties WHERE type = 'Hostel') AS total_hostels,
      (SELECT COUNT(*) FROM users WHERE role = 'owner') AS total_owners,
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS total_students,
      (SELECT COUNT(*) FROM rooms) AS total_rooms,
      (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed') AS confirmed_bookings,
      (SELECT COUNT(*) FROM bookings WHERE status = 'pending_payment') AS pending_bookings,
      (SELECT COUNT(*) FROM payments WHERE status = 'simulated_paid') AS successful_demo_payments,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'simulated_paid') AS demo_payment_total
  `).get();
  const byLocation = db.prepare(`
    SELECT p.location, COUNT(DISTINCT p.id) AS properties,
      COUNT(DISTINCT CASE WHEN p.type = 'Flat' THEN p.id END) AS flats,
      COUNT(DISTINCT CASE WHEN p.type = 'PG' THEN p.id END) AS pgs,
      COUNT(DISTINCT CASE WHEN p.type = 'Hostel' THEN p.id END) AS hostels,
      COUNT(DISTINCT CASE WHEN b.status = 'confirmed' THEN b.user_id END) AS residents
    FROM properties p
    LEFT JOIN rooms r ON r.property_id = p.id
    LEFT JOIN bookings b ON b.room_id = r.id
    GROUP BY p.location ORDER BY p.location COLLATE NOCASE
  `).all();
  res.json({ success: true, stats, by_location: byLocation });
});

app.get('/api/admin/properties', authenticate, requireRole('admin'), (_req, res) => {
  const properties = db.prepare(`
    SELECT p.id, p.name, p.location, p.type, p.is_active, u.name AS owner_name, u.email AS owner_email,
      COUNT(DISTINCT r.id) AS total_rooms, COALESCE(SUM(r.capacity), 0) AS total_beds,
      COUNT(DISTINCT CASE WHEN b.status = 'confirmed' THEN b.id END) AS occupied_beds
    FROM properties p LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN rooms r ON r.property_id = p.id LEFT JOIN bookings b ON b.room_id = r.id
    GROUP BY p.id ORDER BY p.id DESC
  `).all();
  res.json({ success: true, data: properties });
});

app.get('/api/admin/rooms', authenticate, requireRole('admin'), (_req, res) => {
  const rooms = db.prepare(`
    SELECT r.id, r.room_number, r.sharing_type, r.rent_amount, r.capacity, r.is_available,
      p.id AS property_id, p.name AS property_name, p.location, p.type, p.is_active,
      u.name AS owner_name,
      (SELECT COUNT(*) FROM bookings b WHERE b.room_id = r.id AND b.status = 'confirmed') AS occupied_beds
    FROM rooms r JOIN properties p ON p.id = r.property_id
    LEFT JOIN users u ON u.id = p.owner_id
    ORDER BY p.location COLLATE NOCASE, p.name COLLATE NOCASE, r.room_number COLLATE NOCASE
  `).all();
  res.json({ success: true, data: rooms });
});

app.get('/api/admin/users', authenticate, requireRole('admin'), (_req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.location, u.property_type,
      u.is_verified, u.is_active, u.created_at,
      COUNT(DISTINCT b.id) AS booking_count
    FROM users u LEFT JOIN bookings b ON b.user_id = u.id
    GROUP BY u.id ORDER BY u.id DESC
  `).all();
  res.json({ success: true, data: users });
});

app.patch('/api/admin/users/:id/status', authenticate, requireRole('admin'), (req, res) => {
  const userId = Number(req.params.id);
  const isActive = req.body.is_active;
  if (!Number.isSafeInteger(userId) || userId < 1 || typeof isActive !== 'boolean') {
    return sendError(res, 400, 'Choose a valid resident or owner and active status.');
  }
  const target = db.prepare("SELECT role FROM users WHERE id = ? AND role IN ('student', 'owner')").get(userId);
  if (!target) return sendError(res, 404, 'Resident or owner account not found.');

  const updateStatus = db.transaction(() => {
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, userId);
    if (!isActive) db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  });
  updateStatus();
  res.json({ success: true, is_active: isActive });
});

app.patch('/api/admin/users/:id/verification', authenticate, requireRole('admin'), (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1 || typeof req.body.verified !== 'boolean') {
    return sendError(res, 400, 'Choose a valid account and verification status.');
  }
  const result = db.prepare('UPDATE users SET is_verified = ? WHERE id = ? AND role = ?')
    .run(req.body.verified ? 1 : 0, userId, 'student');
  if (!result.changes) return sendError(res, 404, 'Resident account not found.');
  res.json({ success: true });
});

app.get('/api/admin/tenants', authenticate, requireRole('admin'), (req, res) => {
  expirePendingBookings();
  const location = cleanText(req.query.location);
  const params = [];
  let filter = '';
  if (location) {
    filter = 'AND p.location = ?';
    params.push(location);
  }
  const tenants = db.prepare(`
    SELECT u.id AS user_id, u.name, u.email, u.is_verified,
      p.id AS property_id, p.name AS property_name, p.location, p.type,
      r.room_number, r.sharing_type, r.rent_amount,
      b.id AS booking_id, b.status AS booking_status,
      rr.id AS rent_id, rr.billing_month, rr.amount AS rent_amount_due,
      COALESCE(rr.status, b.payment_status) AS rent_status
    FROM bookings b JOIN users u ON u.id = b.user_id
    JOIN rooms r ON r.id = b.room_id JOIN properties p ON p.id = r.property_id
    LEFT JOIN rent_records rr ON rr.id = (
      SELECT latest.id FROM rent_records latest WHERE latest.booking_id = b.id
      ORDER BY latest.billing_month DESC LIMIT 1
    )
    WHERE b.status IN ('confirmed', 'pending_payment') ${filter}
    ORDER BY p.location COLLATE NOCASE, p.name COLLATE NOCASE, u.name COLLATE NOCASE
  `).all(...params);
  const summary = {
    total: tenants.length,
    verified: tenants.filter(tenant => tenant.is_verified).length,
    pending: tenants.filter(tenant => tenant.rent_status === 'pending').length,
    pending_amount: tenants.reduce((sum, tenant) => sum + (tenant.rent_status === 'pending' ? Number(tenant.rent_amount_due || tenant.rent_amount) : 0), 0)
  };
  res.json({ success: true, data: tenants, summary });
});

app.patch('/api/admin/rents/:id', authenticate, requireRole('admin'), (req, res) => {
  const rentId = Number(req.params.id);
  const status = cleanText(req.body.status);
  if (!Number.isSafeInteger(rentId) || rentId < 1 || !['pending', 'paid'].includes(status)) {
    return sendError(res, 400, 'Choose a valid rent record and pending or paid status.');
  }
  const result = db.prepare(`
    UPDATE rent_records SET status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(status, req.user.id, rentId);
  if (!result.changes) return sendError(res, 404, 'Rent record not found.');
  res.json({ success: true });
});

app.get('/api/admin/bookings', authenticate, requireRole('admin'), (_req, res) => {
  expirePendingBookings();
  const bookings = db.prepare(`
    SELECT b.id, b.status, b.payment_status, b.amount_paid, b.booked_at,
      u.name AS tenant_name, u.email AS tenant_email,
      p.id AS property_id, p.name AS property_name, p.location, p.type,
      r.room_number, r.sharing_type, r.rent_amount, o.name AS owner_name
    FROM bookings b JOIN users u ON u.id = b.user_id
    JOIN rooms r ON r.id = b.room_id JOIN properties p ON p.id = r.property_id
    LEFT JOIN users o ON o.id = p.owner_id ORDER BY b.id DESC
  `).all();
  res.json({ success: true, data: bookings });
});

app.post('/api/admin/announcements', authenticate, requireRole('admin'), (req, res) => {
  const location = cleanText(req.body.location);
  const type = cleanText(req.body.type) || 'General';
  const message = cleanText(req.body.message);
  const expiresInDays = announcementExpiry(req.body.expires_in_days);
  if (!location || (location !== '*' && location.length > 120) || !['Utility', 'Maintenance', 'General'].includes(type) ||
      !message || message.length > 1000 || (expiresInDays !== null && ![1, 2].includes(expiresInDays))) {
    return sendError(res, 400, 'Choose a location and announcement type, and enter a message under 1,000 characters.');
  }
  const result = db.prepare(`
    INSERT INTO broadcasts (sender_id, location, type, message, expires_at)
    VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' days') END)
  `).run(req.user.id, location, type, message, expiresInDays, expiresInDays);
  res.status(201).json({ success: true, announcement_id: result.lastInsertRowid });
});

app.get('/api/admin/announcements', authenticate, requireRole('admin'), (_req, res) => {
  db.prepare("DELETE FROM broadcasts WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").run();
  const announcements = db.prepare(`
    SELECT b.id, b.location, b.type, b.message, b.created_at, b.expires_at, u.name AS sender_name
    FROM broadcasts b LEFT JOIN users u ON u.id = b.sender_id
    WHERE b.expires_at IS NULL OR b.expires_at > CURRENT_TIMESTAMP
    ORDER BY b.id DESC LIMIT 100
  `).all();
  res.json({ success: true, data: announcements });
});

app.delete('/api/admin/announcements/:id', authenticate, requireRole('admin'), (req, res) => {
  const announcementId = Number(req.params.id);
  if (!Number.isSafeInteger(announcementId) || announcementId < 1) {
    return sendError(res, 400, 'Choose a valid announcement.');
  }
  const result = db.prepare('DELETE FROM broadcasts WHERE id = ?').run(announcementId);
  if (!result.changes) return sendError(res, 404, 'Announcement not found.');
  res.json({ success: true });
});

app.patch('/api/admin/properties/:id', authenticate, requireRole('admin'), (req, res) => {
  const propertyId = Number(req.params.id);
  if (!Number.isSafeInteger(propertyId) || propertyId < 1 || typeof req.body.is_active !== 'boolean') {
    return sendError(res, 400, 'Choose a valid property and visibility setting.');
  }
  const result = db.prepare('UPDATE properties SET is_active = ? WHERE id = ?')
    .run(req.body.is_active ? 1 : 0, propertyId);
  if (!result.changes) return sendError(res, 404, 'Property not found.');
  res.json({ success: true });
});

app.use('/api', (_req, res) => sendError(res, 404, 'API endpoint not found.'));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ColivSync running at http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log('Development super admin: admin@colivsync.com / Admin@123');
      console.log('Demo payment confirmations do not transfer real money.');
    }
  });
}

module.exports = app;
