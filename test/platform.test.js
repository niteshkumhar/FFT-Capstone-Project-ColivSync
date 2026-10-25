const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'colivsync-test-'));
const databasePath = path.join(testDirectory, 'legacy-colivsync.db');
const uploadDirectory = path.join(testDirectory, 'maintenance-uploads');
const port = 5000 + Math.floor(Math.random() * 1000);
const legacySetup = spawnSync(process.execPath, ['-e', `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.COLIVSYNC_DB_PATH);
  db.exec(\`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, upi_id TEXT);
    INSERT INTO users (id, name, email) VALUES
      (1, 'Legacy resident', 'legacy@example.test'),
      (2, 'Super Admin', 'admin@colivsync.com'),
      (3, 'Super Admin', 'admin@colivsync.com'),
      (4, 'Ramesh Kumar', 'ramesh@owner.com'),
      (5, 'Ramesh Kumar', 'ramesh@owner.com'),
      (6, 'You', 'you@example.com');
    CREATE TABLE properties (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, name TEXT NOT NULL, location TEXT NOT NULL, type TEXT NOT NULL);
    INSERT INTO properties (id, owner_id, name, location, type) VALUES (1, 4, 'Anekal Comfort PG', 'Anekal, Bengaluru', 'PG');
    CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER, room_number TEXT NOT NULL, sharing_type TEXT NOT NULL, rent_amount REAL NOT NULL, is_available INTEGER DEFAULT 1);
    INSERT INTO rooms (id, property_id, room_number, sharing_type, rent_amount, is_available) VALUES
      (1, 1, 'Room 101', 'Single', 6500, 1),
      (2, 1, 'Room 102', 'Shared', 3500, 1);
    CREATE TABLE broadcasts (id INTEGER PRIMARY KEY AUTOINCREMENT, location TEXT, type TEXT NOT NULL DEFAULT 'Utility', message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO broadcasts (id, location, type, message) VALUES (1, 'Anekal, Bengaluru', 'General', 'Legacy announcement');
  \`);
  db.close();
`], {
  cwd: process.cwd(),
  env: { ...process.env, COLIVSYNC_DB_PATH: databasePath },
  encoding: 'utf8'
});

let server;
let origin;
let serverErrorOutput = '';

async function request(route, options = {}) {
  const response = await fetch(`${origin}/api${route}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, data: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`ColivSync test server exited during startup.${serverErrorOutput ? `\n${serverErrorOutput}` : ''}`);
    }
    try {
      const health = await request('/health');
      if (health.status === 200) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('ColivSync test server did not become ready.');
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill();
  await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]);
}

async function main() {
  if (legacySetup.status !== 0) throw new Error(legacySetup.stderr || 'Could not prepare a legacy SQLite database.');
  const environment = {
    ...process.env,
    PORT: String(port),
    COLIVSYNC_DB_PATH: databasePath,
    COLIVSYNC_UPLOAD_DIR: uploadDirectory,
    NODE_ENV: 'test'
  };
  server = spawn(process.execPath, ['backend/server.js'], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', chunk => { serverErrorOutput += chunk; });
  origin = `http://127.0.0.1:${port}`;

  try {
    await waitForServer();
    const overview = await request('/public/overview');
    assert.equal(overview.data.stats.properties, 0);
    const locations = await request('/locations');
    assert.deepEqual(locations.data.data, []);

    const wrongPassword = await request('/login', {
      method: 'POST', body: { email: 'admin@colivsync.com', password: 'wrong-password' }
    });
    assert.equal(wrongPassword.status, 401);
    const adminLogin = await request('/login', {
      method: 'POST', body: { email: 'admin@colivsync.com', password: 'Admin@123' }
    });
    assert.equal(adminLogin.data.user.role, 'admin');
    const adminToken = adminLogin.data.token;
    assert.equal((await request('/admin/overview')).status, 401);
    assert.equal((await request('/admin/overview', { token: adminToken })).status, 200);
    const migratedPeople = await request('/admin/users', { token: adminToken });
    assert.equal(migratedPeople.data.data.filter(user => user.email === 'admin@colivsync.com').length, 1);
    assert.equal(migratedPeople.data.data.some(user => user.email === 'ramesh@owner.com'), false);
    assert.equal(migratedPeople.data.data.some(user => user.email === 'you@example.com'), false);
    const migratedAnnouncements = await request('/admin/announcements', { token: adminToken });
    assert.equal(migratedAnnouncements.status, 200);
    assert.ok(migratedAnnouncements.data.data.some(item => item.message === 'Legacy announcement'));

    const ownerRegistration = await request('/register/owner', {
      method: 'POST',
      body: {
        name: 'Integration Owner',
        email: `owner-${crypto.randomUUID()}@example.test`,
        password: 'OwnerTest@123',
        location: 'Anekal, Bengaluru',
        property_type: 'PG',
        property_name: 'Integration PG'
      }
    });
    assert.equal(ownerRegistration.status, 201);
    assert.equal(ownerRegistration.data.user.role, 'owner');
    const ownerToken = ownerRegistration.data.token;
    const ownerAccountId = ownerRegistration.data.user.id;
    const duplicateOwner = await request('/register/owner', {
      method: 'POST',
      body: {
        name: 'Duplicate Owner',
        email: ownerRegistration.data.user.email,
        password: 'OwnerTest@123',
        location: 'Anekal, Bengaluru',
        property_type: 'PG',
        property_name: 'Duplicate PG'
      }
    });
    assert.equal(duplicateOwner.status, 409);
    const propertyId = ownerRegistration.data.property_id;
    const singleRoomCreated = await request(`/owner/properties/${propertyId}/rooms`, {
      method: 'POST', token: ownerToken,
      body: { room_number: 'Room 101', sharing_type: 'Single', rent_amount: 6500, capacity: 1 }
    });
    assert.equal(singleRoomCreated.status, 201);
    const sharedRoom = await request(`/owner/properties/${propertyId}/rooms`, {
      method: 'POST', token: ownerToken,
      body: { room_number: 'Room 102', sharing_type: 'Shared', rent_amount: 3500, capacity: 3 }
    });
    assert.equal(sharedRoom.status, 201);
    const sharedRooms = await request('/properties?location=Anekal&type=PG&sharing=Shared');
    assert.equal(sharedRooms.data.data.length, 1);
    assert.equal(sharedRooms.data.data[0].available_beds, 3);
    assert.ok((await request('/locations')).data.data.includes('Anekal, Bengaluru'));
    const ownerDashboard = await request('/owner/overview', { token: ownerToken });
    assert.equal(ownerDashboard.data.properties[0].id, propertyId);
    const roomAdded = await request(`/owner/properties/${propertyId}/rooms`, {
      method: 'POST',
      token: ownerToken,
      body: { room_number: 'Room 303', sharing_type: 'Shared', rent_amount: 4200, capacity: 2 }
    });
    assert.equal(roomAdded.status, 201);
    const ownerAnnouncement = await request('/owner/announcements', {
      method: 'POST',
      token: ownerToken,
      body: { property_id: propertyId, type: 'Maintenance', message: 'Water service update at 4 PM.', expires_in_days: '2' }
    });
    assert.equal(ownerAnnouncement.status, 201);
    const ownerAnnouncements = await request('/owner/announcements', { token: ownerToken });
    assert.equal(ownerAnnouncements.status, 200);
    assert.ok(ownerAnnouncements.data.data.some(item => item.message === 'Water service update at 4 PM.'));
    assert.ok(ownerAnnouncements.data.data.find(item => item.message === 'Water service update at 4 PM.').expires_at);

    const roomChoice = sharedRooms.data.data[0];
    const studentEmail = `resident-${crypto.randomUUID()}@example.test`;
    const registration = await request('/register/tenant', {
      method: 'POST',
      body: { name: 'Integration Resident', email: studentEmail, password: 'Resident@123', room_id: roomChoice.room_id }
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.data.payment.status, 'pending');
    assert.equal(registration.data.payment.amount, roomChoice.rent_amount);
    const studentToken = registration.data.token;
    assert.ok(!Object.hasOwn(registration.data.user, 'password_hash'));
    const duplicateResident = await request('/register/tenant', {
      method: 'POST',
      body: { name: 'Duplicate Resident', email: studentEmail.toUpperCase(), password: 'Resident@123', room_id: roomChoice.room_id }
    });
    assert.equal(duplicateResident.status, 409);
    const reducedAvailability = await request(`/properties/${propertyId}/rooms?sharing=Shared`);
    assert.equal(reducedAvailability.data.data.find(room => room.room_id === roomChoice.room_id).available_beds, 2);

    const confirmation = await request(`/payments/${registration.data.payment.id}/confirm`, {
      method: 'POST', token: studentToken, body: {}
    });
    assert.equal(confirmation.status, 200);
    assert.match(confirmation.data.message, /No real money/);
    const residentDashboard = await request('/me/dashboard', { token: studentToken });
    assert.equal(residentDashboard.data.booking.status, 'confirmed');
    assert.equal(residentDashboard.data.booking.payment_status, 'simulated_paid');
    assert.ok(residentDashboard.data.announcements.some(item => item.message === 'Water service update at 4 PM.'));
    assert.equal(residentDashboard.data.payments[0].status, 'simulated_paid');
    const maintenanceRequest = await request('/maintenance-requests', {
      method: 'POST', token: studentToken,
      body: {
        title: 'Bathroom tap is leaking',
        category: 'Plumbing',
        priority: 'high',
        description: 'Water keeps dripping from the cold tap.',
        photo_data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
        photo_mime: 'image/png'
      }
    });
    assert.equal(maintenanceRequest.status, 201);
    const residentRequests = await request('/maintenance-requests', { token: studentToken });
    assert.equal(residentRequests.data.data.length, 1);
    assert.equal(residentRequests.data.data[0].has_photo, true);
    const ownerRequests = await request('/maintenance-requests', { token: ownerToken });
    assert.equal(ownerRequests.data.data.length, 1);
    assert.equal(ownerRequests.data.data[0].resident_name, 'Integration Resident');
    const ownerStatusUpdate = await request(`/maintenance-requests/${maintenanceRequest.data.request_id}`, {
      method: 'PATCH', token: ownerToken,
      body: { status: 'in_progress', message: 'A plumber has been scheduled for tomorrow.' }
    });
    assert.equal(ownerStatusUpdate.status, 200);
    const residentUpdatedRequest = await request('/maintenance-requests', { token: studentToken });
    assert.equal(residentUpdatedRequest.data.data[0].status, 'in_progress');
    assert.equal(residentUpdatedRequest.data.data[0].updates[0].message, 'A plumber has been scheduled for tomorrow.');
    assert.equal((await request(`/maintenance-requests/${maintenanceRequest.data.request_id}`, {
      method: 'PATCH', token: studentToken, body: { status: 'resolved', message: '' }
    })).status, 403);
    const photoResponse = await fetch(`${origin}/api/maintenance-requests/${maintenanceRequest.data.request_id}/photo`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.equal(photoResponse.status, 200);
    assert.match(photoResponse.headers.get('content-type'), /image\/png/);
    assert.ok((await photoResponse.arrayBuffer()).byteLength > 0);
    const ownerRent = await request('/owner/rents', { token: ownerToken });
    assert.equal(ownerRent.data.data.length, 1);
    assert.equal(ownerRent.data.data[0].status, 'simulated_paid');
    assert.equal((await request(`/owner/rents/${ownerRent.data.data[0].id}`, {
      method: 'PATCH', token: ownerToken, body: { status: 'pending' }
    })).status, 200);

    const budgetList = await request('/budgets', { token: studentToken });
    assert.deepEqual(budgetList.data.data.map(budget => budget.category).sort(), ['Food', 'Outings', 'Rent', 'Utilities']);
    assert.equal((await request('/budgets')).status, 401);
    assert.equal((await request('/budgets', { token: ownerToken })).status, 403);
    assert.equal((await request('/budgets', {
      method: 'PUT', token: studentToken, body: { category: 'Food', limit_amount: 100 }
    })).status, 200);
    const expense = await request('/expenses', {
      method: 'POST', token: studentToken,
      body: { title: 'Budget integration test', amount: 120, category: 'Food' }
    });
    assert.equal(expense.status, 201);
    assert.equal(expense.data.alert.level, 'breach');
    const syncedFeed = await request('/upi/sync', { method: 'POST', token: studentToken, body: {} });
    assert.equal(syncedFeed.data.imported, 3);
    const upiExpenses = await request('/expenses?source=UPI', { token: studentToken });
    assert.equal(upiExpenses.data.data.length, 3);
    assert.ok(upiExpenses.data.data.some(item => item.source === 'PhonePe'));
    assert.ok((await request('/alerts', { token: studentToken })).data.unread >= 1);

    const secondRegistration = await request('/register/tenant', {
      method: 'POST',
      body: {
        name: 'Integration Flatmate',
        email: `roommate-${crypto.randomUUID()}@example.test`,
        password: 'Resident@123',
        room_id: roomChoice.room_id
      }
    });
    assert.equal(secondRegistration.status, 201);
    const secondPayment = await request(`/payments/${secondRegistration.data.payment.id}/confirm`, {
      method: 'POST', token: secondRegistration.data.token, body: {}
    });
    assert.equal(secondPayment.status, 200);
    assert.equal((await request('/maintenance-requests', { token: secondRegistration.data.token })).data.data.length, 0);
    const residentFollowup = await request(`/maintenance-requests/${maintenanceRequest.data.request_id}/updates`, {
      method: 'POST', token: studentToken, body: { message: 'I can be home after 5 PM.' }
    });
    assert.equal(residentFollowup.status, 201);
    const ownerUpdatedRequest = await request('/maintenance-requests', { token: ownerToken });
    assert.equal(ownerUpdatedRequest.data.data[0].updates.length, 2);
    assert.equal(ownerUpdatedRequest.data.data[0].updates[1].message, 'I can be home after 5 PM.');
    const sharedBill = await request('/shared-expenses', {
      method: 'POST', token: studentToken,
      body: { title: 'Shared electricity bill', amount: 1000, paid_by: registration.data.user.id }
    });
    assert.equal(sharedBill.status, 201);
    const sharedBalances = await request('/shared', { token: studentToken });
    assert.equal(sharedBalances.data.members.length, 2);
    assert.equal(sharedBalances.data.transfers.length, 1);
    const roommateId = secondRegistration.data.user.id;
    const choresBeforeCrunch = await request('/chores', { token: studentToken });
    assert.equal(choresBeforeCrunch.data.me, registration.data.user.id);
    assert.deepEqual(
      [...new Set(choresBeforeCrunch.data.chores.map(chore => chore.base_assignee))].sort(),
      [registration.data.user.id, roommateId].sort()
    );
    const crunch = await request('/crunch', { method: 'POST', token: studentToken, body: { active: true } });
    assert.equal(crunch.status, 200);
    const choreList = await request('/chores', { token: studentToken });
    assert.equal(choreList.data.crunch_member, registration.data.user.id);
    assert.equal(choreList.data.me, registration.data.user.id);
    assert.ok(choreList.data.chores.some(chore => chore.assignee !== registration.data.user.id));
    assert.ok(choreList.data.chores.every(chore => chore.assignee === roommateId));
    const repeatedCrunch = await request('/crunch', { method: 'POST', token: studentToken, body: { active: true } });
    assert.equal(repeatedCrunch.status, 200);
    const residentNotifications = await request('/alerts', { token: studentToken });
    const roommateNotifications = await request('/alerts', { token: secondRegistration.data.token });
    assert.ok(!residentNotifications.data.alerts.some(item => item.category === 'Household'));
    assert.ok(roommateNotifications.data.alerts.some(item =>
      item.category === 'Household' && item.message ===
        'Integration Resident is in exam crunch mode. Household chores have been reallocated to you.'
    ));
    assert.ok(!(await request('/me/dashboard', { token: studentToken })).data.announcements
      .some(item => item.message.includes('exam crunch mode')));
    const crunchOff = await request('/crunch', { method: 'POST', token: studentToken, body: { active: false } });
    assert.equal(crunchOff.data.crunch_member, null);
    const roommateAfterCrunchOff = await request('/alerts', { token: secondRegistration.data.token });
    assert.ok(roommateAfterCrunchOff.data.alerts.some(item =>
      item.category === 'Household' && item.message.includes('turned off exam crunch mode')
    ));
    const restoredChores = await request('/chores', { token: studentToken });
    assert.ok(restoredChores.data.chores.every(chore => chore.assignee === chore.base_assignee));

    const adminAnnouncement = await request('/admin/announcements', {
      method: 'POST',
      token: adminToken,
      body: { location: '*', type: 'General', message: 'Welcome to ColivSync.', expires_in_days: '1' }
    });
    assert.equal(adminAnnouncement.status, 201);
    const adminAnnouncements = await request('/admin/announcements', { token: adminToken });
    assert.equal(adminAnnouncements.status, 200);
    assert.ok(adminAnnouncements.data.data.some(item => item.message === 'Welcome to ColivSync.'));
    assert.ok(adminAnnouncements.data.data.find(item => item.message === 'Welcome to ColivSync.').expires_at);
    const updatedDashboard = await request('/me/dashboard', { token: studentToken });
    assert.ok(updatedDashboard.data.announcements.some(item => item.message === 'Welcome to ColivSync.'));
    const removedOwnerAnnouncement = await request(`/owner/announcements/${ownerAnnouncement.data.announcement_id}`, {
      method: 'DELETE', token: ownerToken
    });
    assert.equal(removedOwnerAnnouncement.status, 200);
    assert.ok(!(await request('/me/dashboard', { token: studentToken })).data.announcements
      .some(item => item.message === 'Water service update at 4 PM.'));
    const removedAdminAnnouncement = await request(`/admin/announcements/${adminAnnouncement.data.announcement_id}`, {
      method: 'DELETE', token: adminToken
    });
    assert.equal(removedAdminAnnouncement.status, 200);
    assert.ok(!(await request('/me/dashboard', { token: studentToken })).data.announcements
      .some(item => item.message === 'Welcome to ColivSync.'));
    const expiringAnnouncement = await request('/admin/announcements', {
      method: 'POST', token: adminToken,
      body: { location: '*', type: 'General', message: 'Temporary update.', expires_in_days: '1' }
    });
    assert.equal(expiringAnnouncement.status, 201);
    const testDb = new Database(databasePath);
    testDb.prepare("UPDATE broadcasts SET expires_at = datetime('now', '-1 second') WHERE id = ?")
      .run(expiringAnnouncement.data.announcement_id);
    testDb.close();
    const activeAnnouncements = await request('/admin/announcements', { token: adminToken });
    assert.ok(!activeAnnouncements.data.data.some(item => item.message === 'Temporary update.'));

    const singleRoomChoice = (await request('/properties?sharing=Single')).data.data[0];
    const race = await Promise.all([
      request('/register/tenant', { method: 'POST', body: {
        name: 'Resident One', email: `one-${crypto.randomUUID()}@example.test`, password: 'Resident@123', room_id: singleRoomChoice.room_id
      } }),
      request('/register/tenant', { method: 'POST', body: {
        name: 'Resident Two', email: `two-${crypto.randomUUID()}@example.test`, password: 'Resident@123', room_id: singleRoomChoice.room_id
      } })
    ]);
    assert.deepEqual(race.map(result => result.status).sort(), [201, 409]);
    const soloRegistration = race.find(result => result.status === 201);
    assert.ok(soloRegistration);
    assert.equal((await request('/shared', { token: soloRegistration.data.token })).status, 404);
    assert.equal((await request('/chores', { token: soloRegistration.data.token })).status, 404);
    assert.equal((await request('/maintenance-requests', {
      method: 'POST', token: soloRegistration.data.token,
      body: { title: 'Broken light', category: 'Electrical', description: 'The light does not work.' }
    })).status, 403);
    assert.equal((await request('/crunch', {
      method: 'POST', token: soloRegistration.data.token, body: { active: true }
    })).status, 404);

    const adminSummary = await request('/admin/overview', { token: adminToken });
    assert.equal(adminSummary.data.stats.successful_demo_payments, 2);
    const people = await request('/admin/users', { token: adminToken });
    assert.ok(people.data.data.some(user => user.email === studentEmail));
    assert.ok(people.data.data.some(user => user.id === ownerAccountId));
    const tenantLedger = await request('/admin/tenants', { token: adminToken });
    const testTenant = tenantLedger.data.data.find(tenant => tenant.email === studentEmail);
    assert.ok(testTenant);
    assert.equal(testTenant.is_verified, 0);
    assert.equal(testTenant.rent_status, 'pending');
    assert.equal((await request(`/admin/users/${testTenant.user_id}/verification`, {
      method: 'PATCH', token: adminToken, body: { verified: true }
    })).status, 200);
    assert.equal((await request('/admin/tenants', { token: adminToken })).data.data.find(tenant => tenant.email === studentEmail).is_verified, 1);
    assert.equal((await request('/admin/overview', { token: ownerToken })).status, 403);

    const pauseStudent = await request(`/admin/users/${testTenant.user_id}/status`, {
      method: 'PATCH', token: adminToken, body: { is_active: false }
    });
    assert.equal(pauseStudent.status, 200);
    assert.equal((await request('/me', { token: studentToken })).status, 401);
    assert.equal((await request('/login', {
      method: 'POST', body: { email: studentEmail, password: 'Resident@123' }
    })).status, 403);
    assert.equal((await request('/admin/users', { token: adminToken })).data.data.find(user => user.id === testTenant.user_id).is_active, 0);
    assert.equal((await request(`/admin/users/${testTenant.user_id}/status`, {
      method: 'PATCH', token: adminToken, body: { is_active: true }
    })).status, 200);
    const reactivatedLogin = await request('/login', {
      method: 'POST', body: { email: studentEmail, password: 'Resident@123' }
    });
    assert.equal(reactivatedLogin.status, 200);
    assert.equal((await request('/logout', {
      method: 'POST', token: reactivatedLogin.data.token, body: {}
    })).status, 200);
    assert.equal((await request('/me', { token: reactivatedLogin.data.token })).status, 401);

    assert.equal((await request(`/admin/users/${adminLogin.data.user.id}/status`, {
      method: 'PATCH', token: adminToken, body: { is_active: false }
    })).status, 404);
    assert.equal((await request(`/admin/users/${ownerAccountId}/status`, {
      method: 'PATCH', token: adminToken, body: { is_active: false }
    })).status, 200);
    assert.equal((await request(`/properties/${propertyId}/rooms`, { })).data.data.length, 0);
    assert.equal((await request('/login', {
      method: 'POST', body: { email: 'ramesh@owner.com', password: 'Owner@123' }
    })).status, 401);
    assert.equal((await request(`/admin/users/${ownerAccountId}/status`, {
      method: 'PATCH', token: adminToken, body: { is_active: true }
    })).status, 200);

    console.log('PASS: legacy migration; live properties and rooms; password login and role authorization; owner inventory; resident booking; HousePulse maintenance requests, photos, status, and updates; budgets and alerts; UPI examples; shared debt settlement and crunch-mode chores; announcements; admin overview; account pause/reactivation; booking capacity; logout.');
  } finally {
    await stopServer();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = databasePath + suffix;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
