(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const money = value => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const state = { locations: [], properties: [], rooms: [], payment: null, token: null };

  function toast(message, isError = false) {
    const node = document.createElement('div');
    node.className = `toast${isError ? ' error' : ''}`;
    node.textContent = message;
    $('#toastRegion').appendChild(node);
    window.setTimeout(() => node.remove(), 5000);
  }

  function openModal(title, description, content, eyebrow = 'COLIVSYNC') {
    $('#modalTitle').textContent = title;
    $('#modalDescription').textContent = description;
    $('#modalEyebrow').textContent = eyebrow;
    $('#modalContent').innerHTML = content;
    $('#modalBackdrop').hidden = false;
    const first = $('#modalContent').querySelector('input, select, button');
    if (first) first.focus();
  }

  function closeModal() {
    $('#modalBackdrop').hidden = true;
    state.payment = null;
    state.token = null;
  }

  function showMessage(message) {
    const target = $('#formError');
    if (target) target.textContent = message;
  }

  function saveSession(result) {
    localStorage.setItem('colivsync_session', JSON.stringify({
      token: result.token,
      user: result.user
    }));
  }

  function showChoice() {
    openModal('Join your ColivSync community', 'Choose the account that fits how you’ll use the platform.', `
      <div class="choice-grid">
        <button class="choice-button" type="button" data-action="register-tenant"><span>⌂</span><span><b>I’m looking for a room</b><small>Browse PGs, hostels, flats, and room availability.</small></span></button>
        <button class="choice-button" type="button" data-action="register-owner"><span>▦</span><span><b>I manage a property</b><small>List your home and add rooms for residents.</small></span></button>
      </div>`);
  }

  async function showTenantForm() {
    let locationOptions = '';
    try {
      const result = await Api.request('/locations');
      state.locations = result.data || [];
      locationOptions = state.locations.map(location => `<option value="${esc(location)}">${esc(location)}</option>`).join('');
    } catch (error) {
      toast(`Locations could not be loaded: ${error.message}`, true);
    }
    openModal('Find your room', 'Choose a location and explore available homes and rooms.', `
      <form id="tenantForm">
        <div class="form-grid">
          <div class="field"><label for="residentName">Full name</label><input id="residentName" name="name" autocomplete="name" minlength="2" maxlength="100" required></div>
          <div class="field"><label for="residentEmail">Email address</label><input id="residentEmail" name="email" type="email" autocomplete="email" required></div>
          <div class="field full"><label for="residentPassword">Create password</label><input id="residentPassword" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required><small class="field-help">At least 8 characters. Your password is stored as a secure hash.</small></div>
          <div class="field"><label for="residentLocation">Location</label><select id="residentLocation" name="location" required><option value="">Choose a location</option>${locationOptions}</select></div>
          <div class="field"><label for="residentType">Property type</label><select id="residentType" name="property_type" required><option value="">Choose a type</option><option value="PG">PG</option><option value="Hostel">Hostel</option><option value="Flat">Flat</option></select></div>
          <div class="field full"><label for="residentProperty">Property</label><select id="residentProperty" name="property_id" disabled required><option value="">Choose a location and type first</option></select></div>
          <div class="field"><label for="residentSharing">Room sharing</label><select id="residentSharing" name="sharing_type" disabled required><option value="">Choose a property first</option><option value="Single">Single</option><option value="Shared">Shared</option></select></div>
          <div class="field"><label for="residentRoom">Available room</label><select id="residentRoom" name="room_id" disabled required><option value="">Choose sharing type first</option></select></div>
          <div class="form-error full" id="formError" role="alert"></div>
          <div class="form-message full" id="rentNotice">Room choices and monthly rent are loaded live from the property database.</div>
        </div>
        <div class="form-actions"><button class="button button-primary" type="submit">Continue to booking <span>→</span></button></div>
      </form>`);
    $('#residentLocation').addEventListener('change', loadProperties);
    $('#residentType').addEventListener('change', loadProperties);
    $('#residentProperty').addEventListener('change', async () => {
      $('#residentSharing').disabled = !$('#residentProperty').value;
      $('#residentSharing').value = '';
      resetRoomOptions('Choose sharing type first');
      if ($('#residentProperty').value) {
        $('#residentSharing').focus();
      }
    });
    $('#residentSharing').addEventListener('change', loadRooms);
  }

  async function loadProperties() {
    const location = $('#residentLocation').value;
    const type = $('#residentType').value;
    const propertySelect = $('#residentProperty');
    propertySelect.disabled = true;
    propertySelect.innerHTML = '<option value="">Loading available properties…</option>';
    $('#residentSharing').disabled = true;
    $('#residentSharing').value = '';
    resetRoomOptions('Choose a property first');
    if (!location || !type) {
      propertySelect.innerHTML = '<option value="">Choose a location and type first</option>';
      return;
    }
    try {
      const query = new URLSearchParams({ location, type });
      const result = await Api.request(`/properties?${query}`);
      const uniqueProperties = new Map();
      (result.data || []).forEach(room => {
        if (!uniqueProperties.has(String(room.property_id))) uniqueProperties.set(String(room.property_id), room);
      });
      state.properties = [...uniqueProperties.values()];
      propertySelect.innerHTML = state.properties.length
        ? `<option value="">Choose a property</option>${state.properties.map(property => `<option value="${esc(property.property_id)}">${esc(property.property_name)} · ${esc(property.location)}</option>`).join('')}`
        : '<option value="">No properties in this location and type</option>';
      propertySelect.disabled = !state.properties.length;
    } catch (error) {
      propertySelect.innerHTML = '<option value="">Properties unavailable</option>';
      showMessage(error.message);
    }
  }

  function resetRoomOptions(label) {
    const roomSelect = $('#residentRoom');
    roomSelect.disabled = true;
    roomSelect.innerHTML = `<option value="">${esc(label)}</option>`;
    $('#rentNotice').textContent = 'Room choices and monthly rent are loaded live from the property database.';
  }

  async function loadRooms() {
    const propertyId = $('#residentProperty').value;
    const sharing = $('#residentSharing').value;
    const roomSelect = $('#residentRoom');
    roomSelect.disabled = true;
    roomSelect.innerHTML = '<option value="">Loading available rooms…</option>';
    if (!propertyId || !sharing) {
      resetRoomOptions('Choose sharing type first');
      return;
    }
    try {
      const query = new URLSearchParams({ sharing });
      const result = await Api.request(`/properties/${encodeURIComponent(propertyId)}/rooms?${query}`);
      state.rooms = result.data || [];
      roomSelect.innerHTML = state.rooms.length
        ? `<option value="">Choose a room</option>${state.rooms.map(room => `<option value="${esc(room.room_id)}">${esc(room.room_number)} · ${esc(room.sharing_type)} · ${money(room.rent_amount)}/month · ${Number(room.available_beds)} bed(s) available</option>`).join('')}`
        : '<option value="">No rooms of this type are available</option>';
      roomSelect.disabled = !state.rooms.length;
    } catch (error) {
      roomSelect.innerHTML = '<option value="">Could not load rooms</option>';
      showMessage(error.message);
    }
    roomSelect.onchange = () => {
      const room = state.rooms.find(item => String(item.room_id) === roomSelect.value);
      $('#rentNotice').textContent = room
        ? `Monthly rent: ${money(room.rent_amount)}. First month's rent: ${money(room.rent_amount)}. Payment collection is not configured yet.`
        : 'Room choices and monthly rent are loaded live from the property database.';
    };
  }

  function showOwnerForm() {
    openModal('Register your property', 'Create your owner account and first property listing.', `
      <form id="ownerForm">
        <div class="form-grid">
          <div class="field"><label for="ownerName">Full name</label><input id="ownerName" name="name" autocomplete="name" minlength="2" maxlength="100" required></div>
          <div class="field"><label for="ownerEmail">Email address</label><input id="ownerEmail" name="email" type="email" autocomplete="email" required></div>
          <div class="field full"><label for="ownerPassword">Create password</label><input id="ownerPassword" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></div>
          <div class="field"><label for="ownerLocation">Property location</label><input id="ownerLocation" name="location" maxlength="120" placeholder="City or neighbourhood" required></div>
          <div class="field"><label for="ownerType">Property type</label><select id="ownerType" name="property_type" required><option value="PG">PG</option><option value="Hostel">Hostel</option><option value="Flat">Flat</option></select></div>
          <div class="field full"><label for="ownerProperty">Property name</label><input id="ownerProperty" name="property_name" maxlength="120" required></div>
          <div class="form-error full" id="formError" role="alert"></div>
          <div class="form-message full">After creating your account, add room numbers, single/shared type, capacity, and rent from your owner dashboard.</div>
        </div>
        <div class="form-actions"><button class="button button-primary" type="submit">Create owner account <span>→</span></button></div>
      </form>`);
  }

  function showLogin() {
    openModal('Welcome back', 'Log in to continue to your ColivSync dashboard.', `
      <form id="loginForm">
        <div class="form-grid">
          <div class="field full"><label for="loginEmail">Email address</label><input id="loginEmail" name="email" type="email" autocomplete="username" required></div>
          <div class="field full"><label for="loginPassword">Password</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required></div>
          <p class="form-error full" id="formError" role="alert"></p>
          <div class="form-message full">Use the email address and password registered to your account.</div>
        </div>
        <div class="form-actions"><button class="button button-primary" type="submit">Log in <span>→</span></button></div>
      </form>`);
  }

  function showPayment(result) {
    state.payment = result.payment;
    state.token = result.token;
    localStorage.setItem('colivsync_session', JSON.stringify({ token: result.token, user: result.user }));
    openModal('Confirm your booking', 'Review the monthly rent before confirming your booking.', `
      <div class="payment-summary">
        <span>First month of rent</span>
        <strong>${money(result.payment.amount)}</strong>
      </div>
      <div class="form-message payment-warning">Payment collection is not configured. Confirming records your booking but does not charge you.</div>
      <p class="form-error" id="formError" role="alert"></p>
      <div class="form-actions"><button class="button button-outline" type="button" data-action="cancel-demo-payment">Cancel booking</button><button class="button button-primary" type="button" data-action="confirm-demo-payment">Confirm booking <span>→</span></button></div>`, 'BOOKING');
  }

  async function redirectDashboard() {
    window.location.assign('dashboard.html');
  }

  async function submitForm(form) {
    const values = Object.fromEntries(new FormData(form));
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    showMessage('');
    try {
      if (form.id === 'loginForm') {
        const result = await Api.request('/login', { method: 'POST', body: values });
        saveSession(result);
        await redirectDashboard();
      } else if (form.id === 'ownerForm') {
        const result = await Api.request('/register/owner', { method: 'POST', body: values });
        saveSession(result);
        await redirectDashboard();
      } else if (form.id === 'tenantForm') {
        const result = await Api.request('/register/tenant', {
          method: 'POST',
          body: { name: values.name, email: values.email, password: values.password, room_id: values.room_id }
        });
        state.payment = result.payment;
        state.token = result.token;
        showPayment(result);
      }
    } catch (error) {
      showMessage(error.message);
    } finally {
      if (submitButton.isConnected) submitButton.disabled = false;
    }
  }

  async function handleClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'theme') {
      const dark = document.documentElement.dataset.theme !== 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', dark);
      localStorage.setItem('colivsync_theme', dark ? 'dark' : 'light');
    } else if (action === 'login') showLogin();
    else if (action === 'register-choice') showChoice();
    else if (action === 'register-tenant') showTenantForm();
    else if (action === 'register-owner') showOwnerForm();
    else if (action === 'close-modal') closeModal();
    else if (action === 'confirm-demo-payment') {
      button.disabled = true;
      try {
        await Api.request(`/payments/${encodeURIComponent(state.payment.id)}/confirm`, { method: 'POST', token: state.token, body: {} });
        await redirectDashboard();
      } catch (error) {
        button.disabled = false;
        showMessage(error.message);
      }
    } else if (action === 'cancel-demo-payment') {
      button.disabled = true;
      try {
        await Api.request(`/payments/${encodeURIComponent(state.payment.id)}/cancel`, { method: 'POST', token: state.token, body: {} });
        localStorage.removeItem('colivsync_session');
        closeModal();
        toast('The booking was cancelled. No payment was taken.');
      } catch (error) {
        button.disabled = false;
        showMessage(error.message);
      }
    }
  }

  async function loadPublicSummary() {
    try {
      const [overview, locations] = await Promise.all([
        Api.request('/public/overview'),
        Api.request('/locations')
      ]);
      const stats = overview.stats || {};
      $('#heroProperties').textContent = Number(stats.properties) || 0;
      $('#heroRooms').textContent = Number(stats.room_options) || 0;
      $('#heroBeds').textContent = Number(stats.available_beds) || 0;
      const status = $('#apiStatus');
      status.innerHTML = `<i></i> Live data · ${locations.data.length} ${locations.data.length === 1 ? 'location' : 'locations'}`;
    } catch (error) {
      const status = $('#apiStatus');
      status.classList.add('offline');
      status.textContent = 'Community data unavailable';
      toast(`Could not load live community data: ${error.message}`, true);
    }
  }

  document.addEventListener('click', handleClick);
  document.addEventListener('submit', event => {
    const form = event.target.closest('#tenantForm, #ownerForm, #loginForm');
    if (!form) return;
    event.preventDefault();
    submitForm(form);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal();
  });
  $('#footerYear').textContent = new Date().getFullYear();
  loadPublicSummary();
})();
