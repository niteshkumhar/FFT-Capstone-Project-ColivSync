(() => {
  const session = JSON.parse(localStorage.getItem('colivsync_session') || 'null');
  if (!session || !session.token) {
    window.location.replace('index.html');
    return;
  }

  const $ = selector => document.querySelector(selector);
  const content = $('#dashboardContent');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const money = value => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const date = value => value ? new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeStyle: 'short'
  }).format(new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'))) : '—';
  const state = { user: session.user, page: 'overview', data: null, busy: false, photoUrls: [] };
  const nav = {
    student: [['overview', '⌂', 'My home'], ['budgets', '◔', 'Budgets'], ['upi', '↗', 'UPI sync'], ['shared', '⇄', 'Flatmates'], ['chores', '☷', 'Chores'], ['maintenance', '🛠', 'Maintenance'], ['payments', '₹', 'Payments'], ['announcements', '✳', 'Announcements']],
    owner: [['overview', '▦', 'Overview'], ['rooms', '⌂', 'Rooms & availability'], ['residents', '♙', 'Residents & rent'], ['maintenance', '🛠', 'Maintenance'], ['announcements', '✳', 'Announcements']],
    admin: [['overview', '◫', 'Platform overview'], ['properties', '⌂', 'Properties'], ['rooms', '▦', 'Rooms'], ['people', '♙', 'People'], ['bookings', '▤', 'Bookings'], ['tenants', '₹', 'Tenant ledger'], ['announcements', '✳', 'Announcements']]
  };

  function toast(message, error = false) {
    const node = document.createElement('div');
    node.className = `toast${error ? ' error' : ''}`;
    node.textContent = message;
    $('#dashToasts').appendChild(node);
    window.setTimeout(() => node.remove(), 4500);
  }

  function setUser(user) {
    state.user = user;
    $('#profileName').textContent = user.name;
    $('#profileAvatar').textContent = (user.name || 'C').trim().charAt(0).toUpperCase();
    $('#dashLocation').textContent = user.location || user.role;
    document.title = `${user.role === 'admin' ? 'Admin' : user.role === 'owner' ? 'Owner' : 'Resident'} dashboard — ColivSync`;
  }

  function setNavigation() {
    let entries = nav[state.user.role] || [];
    if (state.user.role === 'student' && state.user.sharing_type !== 'Shared') {
      entries = entries.filter(([key]) => key !== 'shared' && key !== 'chores');
    }
    $('#dashNavigation').innerHTML = entries.map(([key, icon, label]) => `
      <button type="button" class="nav-item${state.page === key ? ' active' : ''}" data-page="${key}">
        <span class="nav-item-icon">${icon}</span><span>${label}</span>
      </button>`).join('');
  }

  function title(eyebrow, heading, description, action = '') {
    return `<div class="dash-title-row"><div><span class="dash-eyebrow">${esc(eyebrow)}</span><h1>${esc(heading)}</h1><p>${esc(description)}</p></div>${action}</div>`;
  }

  function stat(label, value, foot = '') {
    return `<article class="stat-card"><span class="stat-label">${esc(label)}</span><strong class="stat-value">${esc(value)}</strong>${foot ? `<div class="stat-foot">${esc(foot)}</div>` : ''}</article>`;
  }

  function badge(label, kind = 'neutral') {
    return `<span class="badge badge-${kind}">${esc(label)}</span>`;
  }

  function statusBadge(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'simulated_paid') return badge('Recorded', 'success');
    if (normalized === 'paid') return badge('Paid', 'success');
    if (normalized === 'confirmed') return badge('Confirmed', 'success');
    if (normalized === 'open') return badge('Open', 'warning');
    if (normalized === 'in_progress') return badge('In progress', 'neutral');
    if (normalized === 'resolved') return badge('Resolved', 'success');
    if (normalized.includes('pending')) return badge('Pending payment', 'warning');
    if (normalized === 'cancelled') return badge('Cancelled', 'danger');
    return badge(status || 'Unknown');
  }

  function empty(message) {
    return `<div class="empty-box">${esc(message)}</div>`;
  }

  function announcementMarkup(item, deleteAction = '') {
    return `<article class="announcement"><div class="announcement-heading"><div>${badge(item.type || 'General')}${item.property_name ? ` ${badge(item.property_name)}` : ''}</div>${deleteAction ? `<button type="button" class="switch-button" data-action="${deleteAction}" data-id="${item.id}">Remove</button>` : ''}</div><p>${esc(item.message)}</p><div class="announcement-dates"><time>Posted ${date(item.created_at)}</time>${item.expires_at ? `<time>Auto-removes ${date(item.expires_at)}</time>` : ''}</div></article>`;
  }

  function card(heading, body, subtitle = '') {
    return `<section class="dash-card"><div class="dash-card-header"><div><h2>${esc(heading)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div></div>${body}</section>`;
  }

  function table(headers, rows, emptyMessage) {
    if (!rows.length) return empty(emptyMessage);
    return `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function listingMetrics(properties) {
    return properties.map(property => `
      <article class="property-card">
        <div class="property-card-top"><div>${badge(property.type)}<h3>${esc(property.name)}</h3><p>${esc(property.location)}</p></div>${badge(property.is_active === 0 ? 'Hidden' : 'Listed', property.is_active === 0 ? 'neutral' : 'success')}</div>
        <div class="property-metrics"><span><b>${Number(property.total_rooms) || 0}</b> rooms</span><span><b>${Number(property.occupied_beds) || 0}/${Number(property.total_beds) || 0}</b> occupied</span></div>
      </article>`).join('');
  }

  function maintenanceRequestMarkup(item, isOwner) {
    const updates = item.updates.map(update => `
      <div class="maintenance-update">
        <div><b>${esc(update.user_name)}</b>${badge(update.user_role === 'owner' ? 'Property owner' : 'Resident')}<time>${date(update.created_at)}</time></div>
        <p>${esc(update.message)}</p>
      </div>`).join('');
    const ownerControls = isOwner ? `
      <form class="maintenance-status-form" data-form="maintenance-status" data-id="${item.id}">
        <div class="field"><label>Status</label><select name="status">
          <option value="open"${item.status === 'open' ? ' selected' : ''}>Open</option>
          <option value="in_progress"${item.status === 'in_progress' ? ' selected' : ''}>In progress</option>
          <option value="resolved"${item.status === 'resolved' ? ' selected' : ''}>Resolved</option>
        </select></div>
        <div class="field"><label>Update for resident</label><input name="message" maxlength="2000" placeholder="Add an update (optional)"></div>
        <button class="button button-primary button-small" type="submit">Save update</button>
      </form>` : '';
    const residentReply = !isOwner ? `
      <form class="maintenance-reply-form" data-form="maintenance-update" data-id="${item.id}">
        <label class="sr-only" for="maintenanceReply${item.id}">Add an update</label>
        <input id="maintenanceReply${item.id}" name="message" maxlength="2000" placeholder="Add information for your property owner…" required>
        <button class="switch-button" type="submit">Send update</button>
      </form>` : '';
    return `<article class="maintenance-card">
      <div class="maintenance-card-heading"><div><span class="maintenance-category">${esc(item.category)}</span><h3>${esc(item.title)}</h3><p>${esc(item.property_name)} · Room ${esc(item.room_number)}${isOwner ? ` · Reported by ${esc(item.resident_name)}` : ''}</p></div><div>${statusBadge(item.status)}${item.priority === 'high' ? ` ${badge('Urgent', 'danger')}` : ''}</div></div>
      <p class="maintenance-description">${esc(item.description)}</p>
      ${item.has_photo ? `<img class="maintenance-photo" data-maintenance-photo="${item.id}" alt="Photo attached to ${esc(item.title)}" hidden>` : ''}
      <div class="maintenance-meta"><span>Opened ${date(item.created_at)}</span><span>Updated ${date(item.updated_at)}</span></div>
      ${updates ? `<div class="maintenance-updates"><h4>Updates</h4>${updates}</div>` : ''}
      ${ownerControls}${residentReply}</article>`;
  }

  async function loadMaintenancePhotos() {
    const images = [...content.querySelectorAll('[data-maintenance-photo]')];
    await Promise.all(images.map(async image => {
      try {
        const response = await fetch(`/api/maintenance-requests/${encodeURIComponent(image.dataset.maintenancePhoto)}/photo`, {
          headers: { Authorization: `Bearer ${Api.getToken()}` }
        });
        if (!response.ok) throw new Error(`Photo request failed (${response.status}).`);
        const objectUrl = URL.createObjectURL(await response.blob());
        state.photoUrls.push(objectUrl);
        image.src = objectUrl;
        image.hidden = false;
      } catch (error) {
        image.alt = `Photo could not be loaded: ${error.message}`;
        image.hidden = false;
      }
    }));
  }

  async function renderStudent(page) {
    if (page === 'overview') {
      const result = state.data || await Api.request('/me/dashboard');
      state.data = result;
      const booking = result.booking;
      const bookingContent = !booking
        ? `<div class="role-banner"><div><span>YOUR NEXT STEP</span><strong>Find a home that fits you.</strong></div><a class="button button-light button-small" href="index.html">Browse rooms</a></div>`
        : `<div class="role-banner"><div><span>${booking.status === 'confirmed' ? 'YOUR COLIVSYNC HOME' : 'BOOKING IN PROGRESS'}</span><strong>${esc(booking.property_name)} · ${esc(booking.room_number)}</strong><span>${esc(booking.location)} · ${esc(booking.sharing_type)} room</span></div><div><strong>${money(booking.rent_amount)}<span> / month</span></strong></div></div>
          <div class="detail-grid">
            <div><span>Property</span><b>${esc(booking.property_name)}</b></div>
            <div><span>Room style</span><b>${esc(booking.sharing_type)} · ${esc(booking.room_number)}</b></div>
            <div><span>Monthly rent</span><b>${money(booking.rent_amount)}</b></div>
            <div><span>Booking status</span><b>${statusBadge(booking.status)}</b></div>
          </div>
          ${booking.payment_status === 'simulated_paid' ? '<div class="form-message payment-warning">Booking confirmed. Payment collection is not configured.</div>' : ''}`;
      const pendingPayment = result.payments.find(payment => payment.status === 'pending');
      const paymentAction = pendingPayment ? `<div class="payment-actions"><button class="button button-primary button-small" type="button" data-action="confirm-payment" data-id="${pendingPayment.id}">Confirm booking · ${money(pendingPayment.amount)}</button><button class="button button-outline button-small" type="button" data-action="cancel-payment" data-id="${pendingPayment.id}">Cancel booking</button></div>` : '';
      const announcements = result.announcements.map(item => announcementMarkup(item)).join('') || empty('No announcements for your community yet.');
      return `${title('RESIDENT DASHBOARD', `Welcome, ${result.user.name}`, 'Your home, booking, and community updates — all in one place.')}
        <div class="dashboard-grid">${stat('Account type', 'Resident', result.user.location || 'ColivSync member')}${stat('Current room', booking ? booking.room_number : '—', booking ? booking.property_name : 'No active booking')}${stat('Monthly rent', booking ? money(booking.rent_amount) : '—', booking ? booking.sharing_type + ' room' : 'Choose a room to get started')}${stat('Payment status', booking ? (booking.payment_status === 'simulated_paid' ? 'Recorded' : 'Pending') : '—', 'Booking payment record')}</div>
        ${card('Your accommodation', `${bookingContent}<div class="detail-action">${paymentAction}</div>`)}
        ${card('Community announcements', announcements, 'Updates shared by your property owner or platform administrator.')}`;
    }
    if (page === 'budgets') {
      const [budgetResult, expenseResult] = await Promise.all([
        Api.request('/budgets'),
        Api.request('/expenses')
      ]);
      const budgets = budgetResult.data || [];
      const expenses = expenseResult.data || [];
      const budgetCards = budgets.map(budget => {
        const percent = Math.min(100, Number(budget.percent) || 0);
        const color = budget.status === 'breach' ? '#bd5143' : budget.status === 'warning' ? '#d09a46' : 'var(--green)';
        return `<article class="budget-card">
          <div class="budget-card-header"><div><span class="dash-eyebrow">${esc(budget.category)}</span><b>${money(budget.spent)} <small>spent</small></b></div>${badge(`${Number(budget.percent)}% used`, budget.status === 'breach' ? 'danger' : budget.status === 'warning' ? 'warning' : 'success')}</div>
          <div class="budget-track"><span style="width:${percent}%;background:${color}"></span></div>
          <form class="budget-edit" data-form="budget"><input type="hidden" name="category" value="${esc(budget.category)}"><label>Monthly cap <span>₹</span><input name="limit_amount" type="number" min="1" step="1" value="${esc(budget.limit_amount)}" required><button class="switch-button" type="submit">Save</button></label></form>
        </article>`;
      }).join('');
      const expenseRows = expenses.slice(0, 12).map(expense => `<tr><td><span class="table-primary">${esc(expense.title)}</span><span class="table-secondary">${date(expense.created_at)}</span></td><td>${badge(expense.category)}</td><td>${esc(expense.source)}</td><td>${money(expense.amount)}</td></tr>`);
      return `${title('RESIDENT DASHBOARD', 'Monthly budgets', 'Track spending against your category limits. Warnings appear at 80% and again if a budget is exceeded.')}
        <div class="budget-grid">${budgetCards || empty('Budget categories are not configured.')}</div>
        ${card('Add an expense', `<form class="dashboard-form" data-form="expense"><div class="field"><label>Description</label><input name="title" maxlength="120" placeholder="Lunch, groceries…" required></div><div class="field"><label>Amount (₹)</label><input name="amount" type="number" min="1" step="1" required></div><div class="field"><label>Category</label><select name="category" required>${budgets.map(budget => `<option value="${esc(budget.category)}">${esc(budget.category)}</option>`).join('')}</select></div><button class="button button-primary" type="submit">Add expense</button></form>`)}
        ${card('Recent expenses', table(['Expense', 'Category', 'Source', 'Amount'], expenseRows, 'No expenses recorded this month.'))}`;
    }
    if (page === 'upi') {
      const result = await Api.request('/expenses?source=UPI');
      const expenses = result.data || [];
      const rows = expenses.map(expense => `<tr><td><span class="table-primary">${esc(expense.title)}</span><span class="table-secondary">${date(expense.created_at)}</span></td><td>${badge(expense.source, 'neutral')}</td><td>${badge(expense.category)}</td><td>${money(expense.amount)}</td></tr>`);
      return `${title('RESIDENT DASHBOARD', 'UPI transaction preview', 'Preview categorized expenses using example transactions.', '<button type="button" class="button button-primary button-small" data-action="sync-upi">Load example transactions</button>')}
        <div class="form-message payment-warning">These example transactions are not retrieved from a bank or payment app.</div>
        ${card('UPI transaction examples', table(['Transaction', 'Source', 'Category', 'Amount'], rows, 'No example transactions loaded yet. Load examples to see how expenses appear in your budget.'))}`;
    }
    if (page === 'shared') {
      const result = await Api.request('/shared');
      const myBalance = result.balances.find(balance => balance.id === result.me);
      const transfers = result.transfers.map(transfer => `<div class="settlement-row"><span>${esc(transfer.from)} pays <b>${esc(transfer.to)}</b></span><strong>${money(transfer.amount)}</strong></div>`);
      const bills = result.bills.map(bill => `<tr><td>${esc(bill.title)}</td><td>${esc(bill.paid_by_name)}</td><td>${money(bill.amount)}</td><td>${date(bill.created_at)}</td></tr>`);
      const members = result.balances.map(member => `<tr><td>${esc(member.name)}${member.id === result.me ? ' (you)' : ''}</td><td>${money(member.paid)}</td><td>${money(member.share)}</td><td>${member.net >= 0 ? '+' : '−'}${money(Math.abs(member.net))}</td></tr>`);
      const memberOptions = result.members.map(member => `<option value="${member.id}">${esc(member.name)}</option>`).join('');
      return `${title('SHARED LIVING', 'Flatmate balance', 'Shared bills are split across household members. Settlements are calculated from live bill data.')}
        <div class="dashboard-grid">${stat('Household members', result.members.length)}${stat('Shared bills', result.bills.length)}${stat('Total bills', money(result.total))}${stat('Your balance', myBalance ? (myBalance.net >= 0 ? '+' : '−') + money(Math.abs(myBalance.net)) : '—', myBalance && myBalance.net >= 0 ? 'You are owed' : 'You owe')}</div>
        <div class="dashboard-columns">${card('Net household balances', table(['Flatmate', 'Paid', 'Fair share', 'Net'], members, 'No household members found.'))}${card('Suggested settlements', transfers.length ? transfers.join('') : empty('Everyone is settled up. Add a shared bill to start.'))}</div>
        ${card('Add a shared bill', `<form class="dashboard-form" data-form="shared-expense"><div class="field"><label>Bill description</label><input name="title" maxlength="120" required></div><div class="field"><label>Amount (₹)</label><input name="amount" type="number" min="1" step="1" required></div><div class="field"><label>Paid by</label><select name="paid_by">${memberOptions}</select></div><button class="button button-primary" type="submit">Add bill</button></form>`)}
        ${card('Household bills', table(['Bill', 'Paid by', 'Amount', 'Date'], bills, 'No shared household bills yet.'))}`;
    }
    if (page === 'maintenance') {
      const result = await Api.request('/maintenance-requests');
      const requests = (result.data || []).map(item => maintenanceRequestMarkup(item, false)).join('');
      return `${title('RESIDENT SERVICES', 'HousePulse maintenance', 'Report a room issue, attach a photo, and follow updates from your property owner.')}
        ${card('Report an issue', `<form class="dashboard-form maintenance-form" data-form="maintenance-request">
          <div class="field"><label>Issue title</label><input name="title" maxlength="100" placeholder="e.g. Leaking bathroom tap" required></div>
          <div class="field"><label>Category</label><select name="category" required><option value="Plumbing">Plumbing</option><option value="Electrical">Electrical</option><option value="Appliances">Appliances</option><option value="Cleaning">Cleaning</option><option value="Other">Other</option></select></div>
          <div class="field"><label>Priority</label><select name="priority"><option value="normal">Normal</option><option value="high">Urgent</option></select></div>
          <div class="field"><label>Photo (optional, max 1 MB)</label><input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></div>
          <div class="field full"><label>Describe the issue</label><textarea name="description" minlength="5" maxlength="2000" required></textarea></div>
          <button class="button button-primary" type="submit">Send maintenance request</button>
        </form>`, 'Add details and a photo so your property owner can understand the issue.') }
        ${card('Your requests', requests || empty('No maintenance requests yet.'))}`;
    }
    if (page === 'chores') {
      const result = await Api.request('/chores');
      const members = result.members || [];
      const crunchOn = Number(result.crunch_member) === Number(result.me);
      const cards = members.map(member => {
        const chores = result.chores.filter(chore => chore.assignee === member.id).map(chore => `<div class="chore-row"><span>${esc(chore.task)}</span>${badge(chore.frequency)}</div>`).join('');
        return `<article class="property-card"><h3>${esc(member.name)}${member.id === result.me ? ' · You' : ''}${Number(result.crunch_member) === Number(member.id) ? ' · 📚 Crunch mode' : ''}</h3>${chores || '<p>No chores assigned.</p>'}</article>`;
      }).join('');
      return `${title('SHARED LIVING', 'Household chore wheel', 'See responsibilities for every flatmate. Exam mode rotates your assigned chores to other household members.', `<button type="button" class="button ${crunchOn ? 'button-outline' : 'button-primary'} button-small" data-action="toggle-crunch" data-active="${crunchOn}">${crunchOn ? 'Turn crunch mode off' : 'Turn exam crunch mode on'}</button>`)}
        ${members.length > 1 ? `<div class="form-message">Chores are reassigned to fellow household members while you are in exam crunch mode. They return to the regular rotation when you turn it off.</div>` : '<div class="form-message">Shared chores and crunch mode become more useful when flatmates join this room.</div>'}
        <div class="property-grid">${cards || empty('No household members or chores found.')}</div>`;
    }
    if (page === 'payments') {
      const result = state.data || await Api.request('/me/dashboard');
      state.data = result;
      const rows = result.payments.map(payment => `<tr><td><span class="table-primary">Booking #${payment.booking_id}</span><span class="table-secondary">${date(payment.created_at)}</span></td><td>${money(payment.amount)}</td><td>${esc(payment.method)}</td><td>${statusBadge(payment.status)}</td><td>${payment.status === 'pending' ? `<button class="switch-button" data-action="confirm-payment" data-id="${payment.id}">Complete</button> <button class="switch-button" data-action="cancel-payment" data-id="${payment.id}">Cancel</button>` : '—'}</td></tr>`);
      return `${title('RESIDENT DASHBOARD', 'Payments', 'View booking charges and payment records.')}
        ${card('Payment history', table(['Booking', 'Amount', 'Method', 'Status', 'Action'], rows, 'No booking payments to display.'))}
        <div class="form-message payment-warning">Payment collection is not configured. These records do not represent collected payments.</div>`;
    }
    const result = state.data || await Api.request('/me/dashboard');
    state.data = result;
    return `${title('RESIDENT DASHBOARD', 'Announcements', 'Updates for your property and local community.')}
      ${card('Your community updates', result.announcements.map(item => announcementMarkup(item)).join('') || empty('There are no announcements yet.'))}`;
  }

  async function renderOwner(page) {
    if (page === 'overview') {
      const result = await Api.request('/owner/overview');
      state.data = result;
      const occupied = result.properties.reduce((sum, property) => sum + Number(property.occupied_beds || 0), 0);
      const totalBeds = result.properties.reduce((sum, property) => sum + Number(property.total_beds || 0), 0);
      return `${title('OWNER WORKSPACE', `Welcome, ${state.user.name}`, 'A live overview of your properties, rooms, and residents.')}
        <div class="dashboard-grid">${stat('Your properties', result.properties.length, 'Managed by your account')}${stat('Rooms listed', result.properties.reduce((sum, item) => sum + Number(item.total_rooms || 0), 0), 'Across all your homes')}${stat('Residents', result.tenants.filter(tenant => tenant.booking_status === 'confirmed').length, 'Confirmed bookings')}${stat('Beds occupied', `${occupied}/${totalBeds}`, 'Current room occupancy')}</div>
        <div class="property-grid">${result.properties.length ? listingMetrics(result.properties) : empty('You have not added a property yet.')}</div>
        ${card('Add another property', `<form class="dashboard-form" data-form="new-property"><div class="field"><label>Property name</label><input name="name" maxlength="120" required></div><div class="field"><label>Property type</label><select name="type"><option value="PG">PG</option><option value="Hostel">Hostel</option><option value="Flat">Flat</option></select></div><div class="field"><label>Location</label><input name="location" maxlength="120" required></div><div class="field"><label>Description</label><input name="description" maxlength="1000"></div><button class="button button-primary" type="submit">Add property</button></form>`)}`;
    }
    if (page === 'rooms') {
      const [overview, roomResult] = await Promise.all([
        Api.request('/owner/overview'),
        Api.request('/owner/rooms')
      ]);
      state.data = { ...overview, rooms: roomResult.data || [] };
      const propertyOptions = overview.properties.map(property => `<option value="${property.id}">${esc(property.name)} · ${esc(property.location)}</option>`).join('');
      const rows = state.data.rooms.map(room => `<div class="room-row"><div><b>${esc(room.property_name)} · ${esc(room.room_number)}</b><span class="table-secondary">${esc(room.location)}</span></div><div>${badge(room.sharing_type)}</div><div>${money(room.rent_amount)}/mo</div><div>${Number(room.occupied_beds)}/${Number(room.capacity)} beds · ${room.is_available ? 'Listed' : 'Hidden'}</div><button class="switch-button" type="button" data-action="toggle-room" data-id="${room.id}" data-available="${room.is_available ? 'true' : 'false'}">${room.is_available ? 'Hide' : 'List'}</button></div>`);
      return `${title('OWNER WORKSPACE', 'Rooms & availability', 'Add room options and keep live inventory up to date.')}
        ${card('Add a room', propertyOptions ? `<form class="dashboard-form" data-form="new-room"><div class="field full"><label>Property</label><select name="property_id" required>${propertyOptions}</select></div><div class="field"><label>Room number or name</label><input name="room_number" maxlength="40" placeholder="Room 101" required></div><div class="field"><label>Room style</label><select name="sharing_type"><option value="Single">Single</option><option value="Shared">Shared</option></select></div><div class="field"><label>Rent per resident / month (₹)</label><input name="rent_amount" type="number" min="1" step="1" required></div><div class="field"><label>Bed capacity</label><input name="capacity" type="number" min="1" max="20" value="1" required></div><button class="button button-primary" type="submit">Add room</button><p class="form-message full">Single rooms have one bed. Shared rooms can have multiple beds; rent is per resident.</p></form>` : empty('Add a property before adding rooms.'))}
        ${card('Your room inventory', rows.join('') || empty('There are no rooms yet. Add a room above to publish availability.'))}`;
    }
    if (page === 'residents') {
      const result = state.data || await Api.request('/owner/overview');
      state.data = result;
      const rentResult = await Api.request('/owner/rents');
      const rows = rentResult.data.map(rent => `<tr><td><span class="table-primary">${esc(rent.tenant_name)}</span><span class="table-secondary">${esc(rent.tenant_email)}</span></td><td>${esc(rent.property_name)} · ${esc(rent.room_number)}<span class="table-secondary">${esc(rent.sharing_type)}</span></td><td>${esc(rent.billing_month)}</td><td>${money(rent.amount)}</td><td>${statusBadge(rent.status)}</td><td><button class="switch-button" data-action="toggle-rent" data-id="${rent.id}" data-status="${esc(rent.status)}">${rent.status === 'pending' ? 'Mark paid' : 'Mark pending'}</button></td></tr>`);
      return `${title('OWNER WORKSPACE', 'Residents & rent', 'Review confirmed residents and maintain a monthly rent ledger.')}
        ${card('Monthly rent ledger', table(['Resident', 'Property / room', 'Month', 'Amount', 'Status', 'Action'], rows, 'Rent records appear here when residents confirm their first-month booking.'))}`;
    }
    if (page === 'maintenance') {
      const result = await Api.request('/maintenance-requests');
      const requests = (result.data || []).map(item => maintenanceRequestMarkup(item, true)).join('');
      return `${title('PROPERTY CARE', 'HousePulse maintenance', 'Review resident reports, track repairs, and keep residents informed.')}
        ${card('Resident requests', requests || empty('No maintenance requests have been submitted yet.'))}`;
    }
    const result = state.data || await Api.request('/owner/overview');
    state.data = result;
    const properties = result.properties || [];
    const [announcements] = await Promise.all([
      Api.request('/owner/announcements'),
      properties.length ? Promise.resolve() : Promise.resolve()
    ]);
    const options = properties.map(property => `<option value="${property.id}">${esc(property.name)} · ${esc(property.location)}</option>`).join('');
    return `${title('OWNER WORKSPACE', 'Announcements', 'Keep residents up to date with important property news.')}
      ${card('Send an update', properties.length ? `<form class="dashboard-form" data-form="owner-announcement"><div class="field"><label>Property</label><select name="property_id" required>${options}</select></div><div class="field"><label>Announcement type</label><select name="type"><option>General</option><option>Utility</option><option>Maintenance</option></select></div><div class="field"><label>Auto-remove</label><select name="expires_in_days"><option value="2" selected>After 2 days</option><option value="1">After 1 day</option><option value="">Never</option></select></div><div class="field full"><label>Message</label><textarea name="message" maxlength="1000" required></textarea></div><button class="button button-primary" type="submit">Send announcement</button></form>` : empty('Add a property first to send an announcement.'))}
      ${card('Previously sent', announcements.data.map(item => announcementMarkup(item, 'delete-owner-announcement')).join('') || empty('You have not sent any announcements yet.'))}`;
  }

  async function renderAdmin(page) {
    if (page === 'overview') {
      const result = await Api.request('/admin/overview');
      state.data = result;
      const stats = result.stats;
      const maximum = Math.max(1, ...result.by_location.map(location => Number(location.properties)));
      const locationChart = result.by_location.map(location => `
        <div class="location-bar-row"><span>${esc(location.location)}</span><div class="location-bar-track"><div class="location-bar-fill" style="width:${Math.min(100, Number(location.properties) * 100 / maximum)}%"></div></div><b>${Number(location.properties)}</b></div>`).join('');
      return `${title('ADMINISTRATION', 'Platform overview', 'Live housing activity across all ColivSync communities.')}
        <div class="dashboard-grid">${stat('Properties', stats.total_properties)}${stat('Property owners', stats.total_owners)}${stat('Residents', stats.total_students)}${stat('Confirmed bookings', stats.confirmed_bookings)}</div>
        <div class="dashboard-grid">${stat('Flats', stats.total_flats)}${stat('PGs', stats.total_pgs)}${stat('Hostels', stats.total_hostels)}${stat('Room options', stats.total_rooms)}</div>
        <div class="dashboard-columns">${card('Properties by location', locationChart || empty('There are no property locations yet.'))}${card('Booking & payment activity', `<div class="detail-grid"><div><span>Pending payment records</span><b>${Number(stats.pending_bookings)}</b></div><div><span>Confirmed payment records</span><b>${Number(stats.successful_demo_payments)}</b></div><div><span>Recorded amount</span><b>${money(stats.demo_payment_total)}</b></div></div><p class="form-message payment-warning">Payment collection is not configured; these are booking records only, not collected funds.</p>`)}</div>`;
    }
    if (page === 'properties') {
      const result = await Api.request('/admin/properties');
      state.data = result.data;
      const rows = result.data.map(property => `<tr><td><span class="table-primary">${esc(property.name)}</span><span class="table-secondary">${esc(property.type)} · ${esc(property.location)}</span></td><td>${esc(property.owner_name || '—')}<span class="table-secondary">${esc(property.owner_email || '')}</span></td><td>${Number(property.total_rooms)} rooms · ${Number(property.occupied_beds)}/${Number(property.total_beds)} beds</td><td>${property.is_active ? badge('Listed', 'success') : badge('Hidden')}</td><td><button class="switch-button" data-action="toggle-property" data-id="${property.id}" data-active="${property.is_active ? 'true' : 'false'}">${property.is_active ? 'Hide' : 'Show'}</button></td></tr>`);
      return `${title('ADMINISTRATION', 'Properties', 'Review property owners, room inventory, and listings.')}
        ${card('All properties', table(['Property', 'Owner', 'Occupancy', 'Visibility', 'Action'], rows, 'No property listings have been created yet.'))}`;
    }
    if (page === 'people') {
      const result = await Api.request('/admin/users');
      const rows = result.data.map(user => `<tr><td><span class="table-primary">${esc(user.name)}</span><span class="table-secondary">${esc(user.email)}</span></td><td>${badge(user.role, user.role === 'admin' ? 'warning' : 'neutral')}</td><td>${user.role === 'admin' ? '—' : badge(user.is_active ? 'Active' : 'Paused', user.is_active ? 'success' : 'danger')}</td><td>${esc(user.location || '—')}</td><td>${esc(user.property_type || '—')}</td><td>${Number(user.booking_count)}</td><td>${date(user.created_at)}</td><td>${['student', 'owner'].includes(user.role) ? `<button class="switch-button" data-action="toggle-account" data-id="${user.id}" data-active="${user.is_active ? 'true' : 'false'}">${user.is_active ? 'Pause account' : 'Reactivate'}</button>` : '—'}</td></tr>`);
      return `${title('ADMINISTRATION', 'People', 'Registered residents, owners, and administrators.')}
        ${card('ColivSync accounts', table(['Name', 'Role', 'Account status', 'Location', 'Property type', 'Bookings', 'Joined', 'Action'], rows, 'There are no registered accounts.'))}`;
    }
    if (page === 'rooms') {
      const result = await Api.request('/admin/rooms');
      const rows = result.data.map(room => `<tr><td><span class="table-primary">${esc(room.property_name)} · ${esc(room.room_number)}</span><span class="table-secondary">${esc(room.location)} · ${esc(room.type)}</span></td><td>${esc(room.owner_name || '—')}</td><td>${badge(room.sharing_type)}</td><td>${money(room.rent_amount)}/mo</td><td>${Number(room.occupied_beds)}/${Number(room.capacity)} beds</td><td>${room.is_available && room.is_active ? badge('Listed', 'success') : badge('Unavailable')}</td></tr>`);
      return `${title('ADMINISTRATION', 'Rooms & availability', 'A database-backed inventory of rooms across every property.')}
        ${card('All room options', table(['Property / room', 'Owner', 'Style', 'Rent per resident', 'Occupancy', 'Availability'], rows, 'There are no rooms in the system yet.'))}`;
    }
    if (page === 'bookings') {
      const result = await Api.request('/admin/bookings');
      const rows = result.data.map(booking => `<tr><td><span class="table-primary">#${booking.id} · ${esc(booking.tenant_name)}</span><span class="table-secondary">${esc(booking.tenant_email)}</span></td><td>${esc(booking.property_name)}<span class="table-secondary">${esc(booking.location)}</span></td><td>${esc(booking.room_number)} · ${esc(booking.sharing_type)}</td><td>${money(booking.rent_amount)}/mo</td><td>${statusBadge(booking.status)}</td><td>${statusBadge(booking.payment_status)}</td></tr>`);
      return `${title('ADMINISTRATION', 'Bookings', 'Current resident bookings and their recorded payment statuses.')}
        ${card('Booking ledger', table(['Resident', 'Property', 'Room', 'Rent', 'Booking', 'Payment'], rows, 'No bookings have been made.'))}`;
    }
    if (page === 'tenants') {
      const result = await Api.request('/admin/tenants');
      const rows = result.data.map(tenant => `<tr><td><span class="table-primary">${esc(tenant.name)}</span><span class="table-secondary">${esc(tenant.email)}</span></td><td>${esc(tenant.property_name)} · ${esc(tenant.location)}</td><td>${esc(tenant.room_number)} · ${esc(tenant.sharing_type)}</td><td>${money(tenant.rent_amount_due || tenant.rent_amount)}</td><td>${tenant.is_verified ? badge('Verified', 'success') : badge('Needs review', 'warning')}</td><td>${statusBadge(tenant.rent_status)}</td><td>${tenant.rent_id ? `<button class="switch-button" data-action="toggle-rent" data-id="${tenant.rent_id}" data-status="${esc(tenant.rent_status)}">${tenant.rent_status === 'pending' ? 'Mark paid' : 'Mark pending'}</button>` : '—'}</td><td><button class="switch-button" data-action="verify-tenant" data-id="${tenant.user_id}" data-verified="${tenant.is_verified ? 'true' : 'false'}">${tenant.is_verified ? 'Unverify' : 'Verify'}</button></td></tr>`);
      return `${title('ADMINISTRATION', 'Tenant occupancy ledger', 'Review residents, room assignments, verification, and first-month rent records.')}
        <div class="dashboard-grid">${stat('Active bookings', result.summary.total)}${stat('Verified residents', result.summary.verified)}${stat('Rent pending', result.summary.pending)}${stat('Outstanding', money(result.summary.pending_amount))}</div>
        ${card('All active tenant bookings', table(['Resident', 'Property', 'Room', 'Rent', 'Verification', 'Rent status', 'Action', 'Review'], rows, 'No resident bookings yet.'))}`;
    }
    const [announcements, locations] = await Promise.all([
      Api.request('/admin/announcements'),
      Api.request('/locations')
    ]);
    const options = (locations.data || []).map(location => `<option value="${esc(location)}">${esc(location)}</option>`).join('');
    const rows = announcements.data.map(item => `<tr><td>${esc(item.location)}</td><td>${badge(item.type)}</td><td>${esc(item.message)}${item.expires_at ? `<span class="table-secondary">Auto-removes ${date(item.expires_at)}</span>` : ''}</td><td>${esc(item.sender_name || '—')}</td><td>${date(item.created_at)}</td><td><button type="button" class="switch-button" data-action="delete-admin-announcement" data-id="${item.id}">Remove</button></td></tr>`);
    return `${title('ADMINISTRATION', 'Community announcements', 'Send updates to residents in a selected location.')}
      ${card('Create announcement', `<form class="dashboard-form" data-form="admin-announcement"><div class="field"><label>Community location</label><select name="location" required><option value="">Choose a location</option><option value="*">All locations</option>${options}</select></div><div class="field"><label>Announcement type</label><select name="type"><option>General</option><option>Utility</option><option>Maintenance</option></select></div><div class="field"><label>Auto-remove</label><select name="expires_in_days"><option value="2" selected>After 2 days</option><option value="1">After 1 day</option><option value="">Never</option></select></div><div class="field full"><label>Message</label><textarea name="message" maxlength="1000" required></textarea></div><button class="button button-primary" type="submit">Publish announcement</button></form>`)}
      ${card('Recent announcements', table(['Location', 'Type', 'Message', 'Sent by', 'Date', 'Action'], rows, 'No platform announcements yet.'))}`;
  }

  async function render() {
    try {
      if (state.user.role === 'student' && !Object.hasOwn(state.user, 'sharing_type')) {
        const dashboard = await Api.request('/me/dashboard');
        state.user.sharing_type = dashboard.booking?.sharing_type || null;
        state.data = dashboard;
      }
      setNavigation();
      state.photoUrls.forEach(URL.revokeObjectURL);
      state.photoUrls = [];
      content.innerHTML = '<div class="dash-loading"><span></span> Loading your workspace…</div>';
      if (state.user.role === 'student') content.innerHTML = await renderStudent(state.page);
      else if (state.user.role === 'owner') content.innerHTML = await renderOwner(state.page);
      else if (state.user.role === 'admin') content.innerHTML = await renderAdmin(state.page);
      else throw new Error('This account does not have a supported dashboard role.');
      if (state.page === 'maintenance') await loadMaintenancePhotos();
    } catch (error) {
      if (error.status === 401) {
        localStorage.removeItem('colivsync_session');
        window.location.replace('index.html');
        return;
      }
      content.innerHTML = `<div class="error-panel"><b>This section could not be loaded.</b><br>${esc(error.message)}<br><button type="button" class="button button-outline button-small" data-action="retry">Try again</button></div>`;
    }
  }

  async function runAction(button) {
    const action = button.dataset.action;
    if ((action === 'delete-owner-announcement' || action === 'delete-admin-announcement') &&
        !window.confirm('Remove this announcement? This cannot be undone.')) return;
    button.disabled = true;
    try {
      if (action === 'sync-upi') {
        const result = await Api.request('/upi/sync', { method: 'POST', body: {} });
        toast(`${result.imported} example transactions added to your expenses.`);
      } else if (action === 'toggle-crunch') {
        const active = button.dataset.active !== 'true';
        await Api.request('/crunch', {
          method: 'POST',
          body: { active }
        });
        toast(active ? 'Exam crunch mode is on. Chores were reallocated.' : 'Crunch mode is off. The regular chore rotation is restored.');
        state.data = null;
      } else if (action === 'delete-owner-announcement' || action === 'delete-admin-announcement') {
        const endpoint = action === 'delete-owner-announcement' ? '/owner/announcements' : '/admin/announcements';
        await Api.request(`${endpoint}/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
        toast('Announcement removed.');
        state.data = null;
      } else if (action === 'confirm-payment') {
        await Api.request(`/payments/${encodeURIComponent(button.dataset.id)}/confirm`, { method: 'POST', body: {} });
        toast('Booking confirmed. Payment collection is not configured.');
        state.data = null;
      } else if (action === 'cancel-payment') {
        await Api.request(`/payments/${encodeURIComponent(button.dataset.id)}/cancel`, { method: 'POST', body: {} });
        toast('Booking cancelled. No payment was processed.');
        state.data = null;
      } else if (action === 'toggle-room') {
        await Api.request(`/owner/rooms/${encodeURIComponent(button.dataset.id)}`, {
          method: 'PATCH', body: { is_available: button.dataset.available !== 'true' }
        });
        toast('Room availability updated.');
        state.data = null;
      } else if (action === 'toggle-property') {
        await Api.request(`/admin/properties/${encodeURIComponent(button.dataset.id)}`, {
          method: 'PATCH', body: { is_active: button.dataset.active !== 'true' }
        });
        toast('Property visibility updated.');
        state.data = null;
      } else if (action === 'toggle-rent') {
        const status = button.dataset.status === 'pending' ? 'paid' : 'pending';
        const endpoint = state.user.role === 'owner' ? '/owner/rents' : '/admin/rents';
        await Api.request(`${endpoint}/${encodeURIComponent(button.dataset.id)}`, {
          method: 'PATCH', body: { status }
        });
        toast(`Rent record marked ${status}.`);
        state.data = null;
      } else if (action === 'verify-tenant') {
        const verified = button.dataset.verified !== 'true';
        await Api.request(`/admin/users/${encodeURIComponent(button.dataset.id)}/verification`, {
          method: 'PATCH', body: { verified }
        });
        toast(`Resident ${verified ? 'verified' : 'marked for review'}.`);
        state.data = null;
      } else if (action === 'toggle-account') {
        const isActive = button.dataset.active !== 'true';
        await Api.request(`/admin/users/${encodeURIComponent(button.dataset.id)}/status`, {
          method: 'PATCH', body: { is_active: isActive }
        });
        toast(isActive ? 'Account reactivated.' : 'Account paused. Existing records were preserved.');
        state.data = null;
      } else if (action === 'retry') {
        state.data = null;
      }
      await render();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  }

  async function submitForm(form) {
    const values = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (form.dataset.form === 'maintenance-request') {
        const photo = form.elements.photo.files[0];
        if (photo && photo.size > 1024 * 1024) throw new Error('Choose a photo no larger than 1 MB.');
        let photoData = '';
        if (photo) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('The selected photo could not be read.'));
            reader.readAsDataURL(photo);
          });
          photoData = String(dataUrl).split(',')[1] || '';
        }
        await Api.request('/maintenance-requests', { method: 'POST', body: {
          title: values.title,
          category: values.category,
          priority: values.priority,
          description: values.description,
          photo_data: photoData,
          photo_mime: photo ? photo.type : ''
        } });
        toast('Maintenance request sent to your property owner.');
      } else if (form.dataset.form === 'maintenance-status') {
        await Api.request(`/maintenance-requests/${encodeURIComponent(form.dataset.id)}`, {
          method: 'PATCH', body: { status: values.status, message: values.message }
        });
        toast('Request status and resident update saved.');
      } else if (form.dataset.form === 'maintenance-update') {
        await Api.request(`/maintenance-requests/${encodeURIComponent(form.dataset.id)}/updates`, {
          method: 'POST', body: { message: values.message }
        });
        toast('Update sent to your property owner.');
      } else if (form.dataset.form === 'new-property') {
        await Api.request('/owner/properties', { method: 'POST', body: {
          name: values.name, location: values.location, type: values.type, description: values.description
        } });
        toast('Property added.');
      } else if (form.dataset.form === 'new-room') {
        const capacity = values.sharing_type === 'Single' ? 1 : Number(values.capacity);
        await Api.request(`/owner/properties/${encodeURIComponent(values.property_id)}/rooms`, {
          method: 'POST', body: {
            room_number: values.room_number,
            sharing_type: values.sharing_type,
            rent_amount: Number(values.rent_amount),
            capacity
          }
        });
        toast('Room added to your property.');
      } else if (form.dataset.form === 'owner-announcement') {
        await Api.request('/owner/announcements', { method: 'POST', body: values });
        toast('Announcement sent to property residents.');
      } else if (form.dataset.form === 'admin-announcement') {
        await Api.request('/admin/announcements', { method: 'POST', body: values });
        toast('Announcement published.');
      } else if (form.dataset.form === 'budget') {
        await Api.request('/budgets', {
          method: 'PUT',
          body: { category: values.category, limit_amount: Number(values.limit_amount) }
        });
        toast(`${values.category} monthly cap updated.`);
      } else if (form.dataset.form === 'expense') {
        const result = await Api.request('/expenses', {
          method: 'POST',
          body: { title: values.title, amount: Number(values.amount), category: values.category }
        });
        toast('Expense added to your budget.');
        if (result.alert) toast(result.alert.message, true);
      } else if (form.dataset.form === 'shared-expense') {
        await Api.request('/shared-expenses', {
          method: 'POST',
          body: { title: values.title, amount: Number(values.amount), paid_by: Number(values.paid_by) }
        });
        toast('Shared bill added. Household balances recalculated.');
      }
      state.data = null;
      await render();
    } catch (error) {
      toast(error.message, true);
      submit.disabled = false;
    }
  }

  async function logout() {
    try {
      await Api.request('/logout', { method: 'POST', body: {} });
    } catch (error) {
      if (error.status !== 401) toast(error.message, true);
    }
    localStorage.removeItem('colivsync_session');
    window.location.replace('index.html');
  }

  async function refreshAlerts(showError = false) {
    if (state.user.role !== 'student') return false;
    try {
      const result = await Api.request('/alerts');
      const unread = Number(result.unread) || 0;
      const badgeElement = $('#notificationCount');
      badgeElement.textContent = unread > 9 ? '9+' : String(unread);
      badgeElement.hidden = unread === 0;
      const alerts = result.alerts || [];
      $('#notificationPanel').innerHTML = `<h3>Notifications</h3>${alerts.length
        ? alerts.map(item => `<div class="notification-item ${esc(item.level)}">${item.type === 'household' ? badge('Household') : badge('Budget')} ${esc(item.message)}<time>${date(item.created_at)}</time></div>`).join('')
        : '<div class="empty-box">You have no notifications.</div>'}`;
      return true;
    } catch (error) {
      $('#notificationPanel').innerHTML = `<h3>Notifications</h3><div class="error-panel" role="alert">Notifications are unavailable: ${esc(error.message)}<br><button type="button" class="button button-outline button-small" data-action="retry-alerts">Try again</button></div>`;
      if (showError && error.status !== 401) toast(`Notifications unavailable: ${error.message}`, true);
      return false;
    }
  }

  document.addEventListener('click', event => {
    const navButton = event.target.closest('[data-page]');
    if (navButton) {
      state.page = navButton.dataset.page;
      state.data = null;
      render();
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    if (actionButton.dataset.action === 'retry-alerts') {
      refreshAlerts(true);
      return;
    }
    runAction(actionButton);
  });
  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    submitForm(form);
  });
  document.addEventListener('change', event => {
    if (event.target.matches('select[name="sharing_type"]')) {
      const capacity = event.target.form.elements.capacity;
      if (capacity) {
        capacity.min = event.target.value === 'Shared' ? '2' : '1';
        capacity.value = event.target.value === 'Shared' ? '2' : '1';
      }
    }
  });
  $('#themeButton').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('colivsync_theme', dark ? 'dark' : 'light');
  });
  $('#notificationButton').addEventListener('click', async () => {
    const panel = $('#notificationPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      const loaded = await refreshAlerts(true);
      if (loaded && Number($('#notificationCount').textContent) > 0) {
        try {
          await Api.request('/alerts/read', { method: 'POST', body: {} });
          await refreshAlerts(true);
        } catch (error) {
          toast(`Notifications could not be marked as read: ${error.message}`, true);
        }
      }
    }
  });
  $('#logoutButton').addEventListener('click', logout);
  window.setInterval(refreshAlerts, 20000);

  (async () => {
    try {
      const result = await Api.request('/me');
      setUser(result.user);
      state.page = 'overview';
      await render();
      refreshAlerts();
    } catch {
      localStorage.removeItem('colivsync_session');
      window.location.replace('index.html');
    }
  })();
})();
