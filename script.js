// ============================================
// STATE MANAGEMENT
// ============================================
let sidebarCollapsed = false;
let btDevice = null, btTx = null, btNotifyChar = null, btConnected = false;
let uartBuffer = '';
let currentAlertId = null;
let currentGmailId = null;
let alertCount = 0;
let eventHistory = [];
let gmailKnownMessageIds = new Set();
let gmailBaselineCaptured = false;
let gmailMessages = [];

const NUS_SERVICE_UUID = 'e95d0753-251d-470a-a062-fa1922dfa9a8';
const NUS_RX_CHAR_UUID = 'e95d5404-251d-470a-a062-fa1922dfa9a8';
const NUS_TX_CHAR_UUID = 'e95d93ee-251d-470a-a062-fa1922dfa9a8';

// Alert source configuration
const sources = { email: true, call: true, message: true, notif: false };
const sourceConfig = {
  call: { icon: '📞', title: 'Incoming Call', urgency: 'h', cmd: 'CALL:HIGH' },
  message: { icon: '💬', title: 'New Message', urgency: 'm', cmd: 'MSG:MED' },
  email: { icon: '✉️', title: 'Email Received', urgency: 'l', cmd: 'EMAIL:LOW' },
  notif: { icon: '🔔', title: 'Notification', urgency: 'l', cmd: 'NOTIF:LOW' }
};

// Initial alerts array
let alerts = [{
  id: 1,
  icon: '✅',
  lvl: 'info',
  title: 'App Ready',
  src: 'VigilBoard',
  time: '--:--',
  urgency: 'l',
  unread: false,
  body: 'Connect Bluetooth and choose sources to start sending alerts to your micro:bit.'
}];

// ============================================
// UTILITY FUNCTIONS
// ============================================
// Get current time in HH:MM:SS format
function nowTime() {
  return new Date().toLocaleTimeString('en-SG', { hour12: false });
}

// Toggle sidebar collapse state
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', sidebarCollapsed);
}

// Page metadata for navigation
const pageMeta = {
  dashboard: ['Dashboard', 'PHONE ALERTS → MICRO:BIT'],
  bluetooth: ['Bluetooth', 'DEVICE CONFIGURATION'],
  sources: ['Sources', 'CONFIGURE INPUT FILTERS'],
  settings: ['Settings', 'PREFERENCES & DEVICE']
};

// Switch between pages in the app and update header
function switchPage(name, navEl) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  // Match nav item by data-page if navEl not passed or doesn't have data-page
  const targetNav = navEl && navEl.dataset && navEl.dataset.page ? navEl : document.querySelector(`.nav-item[data-page="${name}"]`);
  if (targetNav) targetNav.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  if (page) page.classList.add('active');
  const [title, sub] = pageMeta[name] || ['', ''];
  // Update centered page label in top bar
  const pageTitle = name.charAt(0).toUpperCase() + name.slice(1);
  const labelEl = document.getElementById('pageLabel');
  if (labelEl) labelEl.textContent = pageTitle;
  // Legacy support
  const pageTitleEl = document.getElementById('pageTitle');
  if (pageTitleEl) pageTitleEl.textContent = pageTitle;
  const pageSubEl = document.getElementById('pageSub');
  if (pageSubEl) pageSubEl.textContent = sub;
}

/* ============================================
   ALERT MANAGEMENT
   ============================================ */
// Render all alerts in the alert list
function renderAlerts() {
  const el = document.getElementById('alertList');
  if (!el) return;
  if (!alerts.length) {
    el.innerHTML = '<div class="empty"><div class="ei">🔕</div><p>No alerts yet</p></div>';
    updateCounts();
    return;
  }
  el.innerHTML = alerts.map(a => `
    <div class="alert-item ${a.unread ? 'unread' : ''}" onclick='modalOpen(${JSON.stringify(a.id)})'>
      <div class="a-icon ${a.lvl}">${a.icon}</div>
      <div class="a-body">
        <div class="a-title">${a.title}</div>
        <div class="a-meta">${a.src} · ${a.time}</div>
      </div>
      <div class="a-badge ${a.urgency === 'h' ? 'badge-h' : a.urgency === 'm' ? 'badge-m' : 'badge-l'}">
        ${a.urgency === 'h' ? 'HIGH' : a.urgency === 'm' ? 'MED' : 'LOW'}
      </div>
      <button type='button' class='ack-btn' onclick='ackAlert(${JSON.stringify(a.id)}, event)'>Acknowledge</button>
    </div>
  `).join('');
  updateCounts();
}

function updateCounts() {
  const total = document.getElementById('totalAlerts');
  const unread = document.getElementById('unreadAlerts');
  const crit = document.getElementById('critAlerts');
  const badge = document.getElementById('navBadge');
  const unreadCount = alerts.filter(a => a.unread).length;
  if (total) total.textContent = alertCount;
  if (unread) unread.textContent = unreadCount;
  if (crit) crit.textContent = btConnected ? 1 : 0;
  if (badge) badge.style.display = unreadCount > 0 ? '' : 'none';
}

// Clear all alerts and reset the live feed
function clearAlerts() {
  alerts = [];
  alertCount = 0;
  eventHistory = [];
  renderAlerts();
  buildChart();
}

// Add a new alert to the top of the list
function recordEvent() {
  const now = Date.now();
  eventHistory.push(now);
  const hourAgo = now - 3600000;
  eventHistory = eventHistory.filter(ts => ts >= hourAgo);
}

function addAlert(a) {
  alertCount += 1;
  const alert = { id: a.id || Date.now(), time: nowTime(), ...a };
  alerts.unshift(alert);
  recordEvent();
  renderAlerts();
  buildChart();
}

/* ============================================
   MODAL DIALOG: Alert details
   ============================================ */
// Open alert modal with details
function modalOpen(id) {
  const a = alerts.find(x => x.id === id);
  if (!a) return;
  currentAlertId = id;
  document.getElementById('mIcon').textContent = a.icon;
  document.getElementById('mTitle').textContent = a.title;
  document.getElementById('mSub').textContent = `${a.src} · Today at ${a.time}`;
  document.getElementById('mBody').textContent = a.body;
  document.getElementById('alertModal').classList.add('open');
}

// Close the alert modal
function modalClose(e) {
  if (!e || e.target.id === 'alertModal') document.getElementById('alertModal').classList.remove('open');
}

// Acknowledge an alert (mark as read and close modal)
function modalAck() {
  if (currentAlertId) {
    alerts = alerts.map(a => a.id === currentAlertId ? { ...a, unread: false } : a);
    renderAlerts();
  } else if (currentGmailId) {
    alerts = alerts.map(a => a.id === currentGmailId ? { ...a, unread: false } : a);
    renderAlerts();
  }
  currentAlertId = null;
  currentGmailId = null;
  document.getElementById('alertModal').classList.remove('open');
}

function ackAlert(id, event) {
  if (event && event.stopPropagation) {
    event.stopPropagation();
  }
  if (id == null) return;
  alerts = alerts.map(a => a.id === id ? { ...a, unread: false } : a);
  renderAlerts();
}

/* ============================================
   MICRO:BIT DASHBOARD & DISPLAY
   ============================================ */
// Build the micro:bit status grid
function buildMicroGrid() {
  const el = document.getElementById('ledMatrix');
  if (!el) return;
  el.innerHTML = ['BT', 'RX', 'TX', 'OK'].map(x => `<div class="led-cell">${x}</div>`).join('');
}

// Test flash animation on screen
function testFlash() {
  screenFlash('#00d4ff');
  sendCmd('TEST:ALL');
}

// Flash the entire screen with a color
function screenFlash(color = '#00d4ff') {
  const f = document.getElementById('flashOverlay');
  if (!f) return;
  f.style.background = color;
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
  setTimeout(() => f.classList.remove('go'), 350);
}

/* ============================================
   BLUETOOTH LOGGING & COMMUNICATION
   ============================================ */
// Log a message to the Bluetooth serial console
function btLog(msg, cls = '') {
  const log = document.getElementById('btLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'log-line ' + (cls || '');
  line.innerHTML = `<span class="log-time">${nowTime()}</span>${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// Clear the Bluetooth log
function clearLog() {
  const log = document.getElementById('btLog');
  if (!log) return;
  log.innerHTML = '';
  btLog('Log cleared.', 'info');
}

function handleUartNotification(event) {
  const value = event.target.value;
  if (!value) return;

  uartBuffer += new TextDecoder().decode(value);
  let newlineIndex;

  while ((newlineIndex = uartBuffer.indexOf('\n')) !== -1) {
    const rawMessage = uartBuffer.slice(0, newlineIndex);
    uartBuffer = uartBuffer.slice(newlineIndex + 1);
    const message = rawMessage.trim();
    if (!message) continue;

    btLog(`RX ← ${message}`, 'info');
  }
}

/* ============================================
   BLUETOOTH DEVICE MANAGEMENT
   ============================================ */
// Render empty state for device list
function renderDeviceEmptyState(message = 'No device found') {
  const list = document.getElementById('btDeviceList');
  if (!list) return;
  list.innerHTML = `
    <div class="empty bt-empty">
      <div class="ei">📡</div>
      <p>${message}</p>
      <span>Turn on Bluetooth and scan again to find your micro:bit.</span>
    </div>
  `;
}

// Render available device in the device list
function renderAvailableDevice(dev) {
  const list = document.getElementById('btDeviceList');
  if (!list) return;
  list.innerHTML = `
    <div class="bt-device-item paired" onclick="btConnectDevice(window.__btLastDevice)">
      <div class="bt-dev-icon">📟</div>
      <div>
        <div class="bt-dev-name">${dev.name || 'Unknown device'}</div>
        <div class="bt-dev-sub">Available device</div>
      </div>
      <div class="bt-signal"><span></span><span></span><span></span></div>
    </div>
  `;
}

// Scan for available Bluetooth devices
async function btScan() {
  addAlert({
    icon: '📡',
    lvl: 'info',
    title: 'Bluetooth scan started',
    src: 'Bluetooth',
    urgency: 'l',
    unread: false,
    body: 'Scanning for nearby micro:bit devices.'
  });
  btLog('Scanning for Bluetooth devices…', 'info');
  document.getElementById('btStateTitle').textContent = 'Scanning…';
  document.getElementById('btStateSub').textContent = 'Looking for nearby micro:bit devices';
  document.getElementById('btIconWrap').className = 'bt-orb-ring disconnected-icon';

  if (!navigator.bluetooth) {
    btLog('Web Bluetooth is not supported in this browser.', 'err');
    document.getElementById('btStateTitle').textContent = 'Bluetooth unavailable';
    document.getElementById('btStateSub').textContent = 'Use a supported browser';
    renderDeviceEmptyState('Bluetooth not supported');
    setDisconnectedUI();
    return;
  }

  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'BBC micro:bit' },
        { namePrefix: 'micro:bit' },
        { namePrefix: 'AlertBridge' }
      ],
      optionalServices: [NUS_SERVICE_UUID]
    });

    window.__btLastDevice = dev;
    btLog(`Found: ${dev.name || 'Unknown device'}`, 'ok');
    renderAvailableDevice(dev);
    await btConnectDevice(dev);
  } catch (e) {
    if (e.name === 'NotFoundError') {
      btLog('No device found with filtered scan; falling back to broader scan…', 'info');
      try {
        const dev = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [NUS_SERVICE_UUID]
        });

        window.__btLastDevice = dev;
        btLog(`Found: ${dev.name || 'Unknown device'}`, 'ok');
        renderAvailableDevice(dev);
        await btConnectDevice(dev);
        return;
      } catch (innerError) {
        btLog(`Scan failed: ${innerError.message}`, 'err');
        addAlert({
          icon: '❌',
          lvl: 'crit',
          title: 'Bluetooth scan failed',
          src: 'Bluetooth',
          urgency: 'h',
          unread: false,
          body: 'Scanning failed: ' + innerError.message
        });
        document.getElementById('btStateTitle').textContent = 'Scan failed';
        document.getElementById('btStateSub').textContent = 'Please try again';
        renderDeviceEmptyState('Scan failed');
        setDisconnectedUI();
        return;
      }
    }

    btLog(`Error: ${e.message}`, 'err');
    document.getElementById('btStateTitle').textContent = 'Scan failed';
    document.getElementById('btStateSub').textContent = 'Please try again';
    renderDeviceEmptyState('Scan failed');
    setDisconnectedUI();
  }
}

// Connect to a specific Bluetooth device
async function btConnectDevice(dev) {
  if (!dev) return;

  btLog(`Connecting to ${dev.name || 'device'}…`, 'info');

  try {
    const server = await dev.gatt.connect();

    // Wait until UART service is actually available
    async function getUartService(server, retries = 6) {
      for (let i = 0; i < retries; i++) {
        try {
          return await server.getPrimaryService(NUS_SERVICE_UUID);
        } catch (e) {
          console.warn(`Service discovery attempt ${i+1} failed:`, e.message); // log it!
          await new Promise(r => setTimeout(r, 300));
        }
      }
      throw new Error("UART service not available");
    }

    const service = await getUartService(server);

    const tx = await service.getCharacteristic(NUS_RX_CHAR_UUID);
    const rx = await service.getCharacteristic(NUS_TX_CHAR_UUID);

    btTx = tx;
    btNotifyChar = rx;

    await btNotifyChar.startNotifications();
    btNotifyChar.addEventListener(
      'characteristicvaluechanged',
      handleUartNotification
    );

    btDevice = dev;
    btConnected = true;

    setConnectedUI(dev.name || 'micro:bit');
    btLog("Connected ✓", "ok");

    await sendCmd("PING");

    dev.addEventListener('gattserverdisconnected', () => {
      btConnected = false;
      btTx = null;
      btNotifyChar = null;
      btDevice = null;
      uartBuffer = '';
      setDisconnectedUI();
      addAlert({
        icon: '⚠️',
        lvl: 'warn',
        title: 'Bluetooth disconnected',
        src: 'Bluetooth',
        urgency: 'm',
        unread: false,
        body: 'The micro:bit was disconnected.'
      });
      btLog('Disconnected', 'err');
    });

  } catch (e) {
    btLog(`Connection failed: ${e.message}`, 'err');
    addAlert({
      icon: '❌',
      lvl: 'crit',
      title: 'Bluetooth connection failed',
      src: 'Bluetooth',
      urgency: 'h',
      unread: false,
      body: e.message
    });
    setDisconnectedUI();
  }
}
/* ============================================
   BLUETOOTH UI STATE MANAGEMENT
   ============================================ */
// Update UI when device is connected
function setConnectedUI(name) {
  document.getElementById('btStateTitle').textContent = 'Connected';
  document.getElementById('btStateSub').textContent = name;
  document.getElementById('btIconWrap').className = 'bt-orb-ring connected-icon';
  document.getElementById('btScanBtn').style.display = 'none';
  document.getElementById('btDisconnectBtn').style.display = '';
  const cmdNote = document.getElementById('btCmdNote');
  if (cmdNote) cmdNote.style.display = 'none';
  document.getElementById('btInfoStatus').textContent = 'Connected ✓';
  document.getElementById('btInfoStatus').style.color = 'var(--ok)';
  const chip = document.getElementById('btChip');
  if (chip) chip.className = 'status-pill connected';
  const chipLabel = document.getElementById('btChipLabel');
  if (chipLabel) chipLabel.textContent = 'Connected';
  const btDot = document.getElementById('btDot');
  if (btDot) { btDot.style.background = 'var(--ok)'; btDot.style.boxShadow = '0 0 6px var(--ok)'; }
  const connIndicator = document.getElementById('connIndicator');
  if (connIndicator) connIndicator.classList.remove('disconnected');
  const connLabel = document.getElementById('connLabel');
  if (connLabel) connLabel.textContent = 'Connected';
  document.getElementById('settingsBtStatus').textContent = name;
  updateCounts();
}

// Update UI when device is disconnected
function setDisconnectedUI() {
  document.getElementById('btStateTitle').textContent = 'No Device Connected';
  document.getElementById('btStateSub').textContent = 'Scan to find your micro:bit';
  document.getElementById('btIconWrap').className = 'bt-orb-ring disconnected-icon';
  document.getElementById('btScanBtn').style.display = '';
  document.getElementById('btDisconnectBtn').style.display = 'none';
  const cmdNote = document.getElementById('btCmdNote');
  if (cmdNote) cmdNote.style.display = '';
  document.getElementById('btInfoStatus').textContent = 'Disconnected';
  document.getElementById('btInfoStatus').style.color = 'var(--crit)';
  const chip = document.getElementById('btChip');
  if (chip) chip.className = 'status-pill';
  const chipLabel = document.getElementById('btChipLabel');
  if (chipLabel) chipLabel.textContent = 'No Device';
  const btDot = document.getElementById('btDot');
  if (btDot) { btDot.style.background = 'var(--crit)'; btDot.style.boxShadow = '0 0 6px var(--crit)'; }
  const connIndicator = document.getElementById('connIndicator');
  if (connIndicator) connIndicator.classList.add('disconnected');
  const connLabel = document.getElementById('connLabel');
  if (connLabel) connLabel.textContent = 'No Device';
  document.getElementById('settingsBtStatus').textContent = 'No device connected';
  updateCounts();
}

// Disconnect from the current Bluetooth device
async function btDisconnect() {
  if (btDevice && btDevice.gatt.connected) {
    btDevice.gatt.disconnect();
  }
  if (btNotifyChar) {
    btNotifyChar.removeEventListener('characteristicvaluechanged', handleUartNotification);
    btNotifyChar = null;
  }
  btConnected = false;
  btDevice = null;
  btTx = null;
  uartBuffer = '';
  setDisconnectedUI();
  btLog('Disconnected.', 'info');
  renderDeviceEmptyState('No device connected');
}

/* ============================================
   COMMAND SENDING & MESSAGE PROTOCOL
   ============================================ */
// Send a command to the connected device
async function sendCmd(cmd) {
  btLog(`TX → ${cmd}`, 'info');
  if (!btConnected || !btTx || !(btDevice && btDevice.gatt && btDevice.gatt.connected)) {
    btLog('Connect a Bluetooth device first.', 'err');
    return;
  }
  try {
    const encoded = new TextEncoder().encode(cmd + '\n');
    await btTx.writeValue(encoded);
    btLog(`Sent: ${cmd}`, 'ok');
  } catch (e) {
    btLog(`Send failed: ${e.message}`, 'err');
    return;
  }
  const [type, urg, src] = cmd.split(':');
  if (type && type !== 'TEST') triggerAlert(type.toLowerCase(), urg || 'l', src || 'PHONE');
  if (type === 'TEST') screenFlash('#00d4ff');
}

// Send a custom command from user input
function sendCustomCmd() {
  const v = document.getElementById('customCmd').value.trim();
  if (v) sendCmd(v);
}

/* ============================================
   ALERT TRIGGERING & SOURCE MANAGEMENT
   ============================================ */
// Trigger an alert with given parameters
function triggerAlert(type, urgency = 'l', src = 'PHONE') {
  const cfg = sourceConfig[type.toLowerCase()] || { icon: '🔔', title: 'Alert', urgency: 'l' };
  const body = `${cfg.title} from ${src}. Command sent to micro:bit: ${type.toUpperCase()}:${urgency.toUpperCase()}`;

  addAlert({
    icon: cfg.icon,
    lvl: urgency === 'h' ? 'crit' : urgency === 'm' ? 'warn' : 'info',
    title: cfg.title,
    src: src,
    time: nowTime(),
    urgency: urgency,
    unread: true,
    body
  });

  screenFlash(urgency === 'h' ? '#ff4757' : urgency === 'm' ? '#ffb340' : '#00d4ff');
}

// Toggle an alert source on/off
function toggleSource(name, tog) {
  sources[name] = tog.classList.toggle('on');
}

// Simulate receiving an email alert
function simulateEmailAlert() {
  if (!sources.email) return;
  const sender = document.getElementById('emailSender').value.trim() || 'name@example.com';
  const keyword = document.getElementById('emailKeyword').value.trim();
  const cmd = document.getElementById('emailCmd').value.trim() || 'EMAIL:LOW:MAIL';
  triggerAlert('email', 'l', sender);
  btLog(`Email matched: ${sender}${keyword ? ` | keyword: ${keyword}` : ''}`, 'info');
  if (btConnected) sendCmd(cmd);
}

// Reset all app settings to defaults
function resetSettings() {
  if (confirm('Reset all settings to defaults?')) location.reload();
}

// Build the activity chart for dashboard
function buildChart() {
  const el = document.getElementById('miniChart');
  if (!el) return;
  const now = Date.now();
  const hourAgo = now - 3600000;
  const bucketSize = 3600000 / 8;
  const buckets = Array.from({ length: 8 }, () => 0);

  eventHistory.forEach(ts => {
    if (ts >= hourAgo) {
      let index = Math.floor((ts - hourAgo) / bucketSize);
      if (index < 0) index = 0;
      if (index > 7) index = 7;
      buckets[index] += 1;
    }
  });

  const max = Math.max(...buckets, 1);
  el.innerHTML = buckets.map((count, i) =>
    `<div class="bar ${count > 0 ? 'hi' : ''}" style="height:${Math.round(count / max * 100)}%"></div>`
  ).join('');
}

// ============================================
// GMAIL INTEGRATION
// ============================================
let gmailToken = null;
let gmailEmail = null;

const GOOGLE_CLIENT_ID = "768854227704-2mc6bip356pa56ejomb9lss8noc1b82c.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";
let tokenClient;

async function fetchGmailProfile() {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${gmailToken}` } }
  );
  const data = await res.json();
  gmailEmail = data.emailAddress;
  document.getElementById("connectedEmail").textContent = gmailEmail;
  document.getElementById("googleSignInBtn").style.display = "none";
  document.getElementById("googleSignOutBtn").style.display = "inline-block";
}

function startPolling() {
  setInterval(fetchGmail, 15000);
}

// ============================================
// EXPOSE GLOBALS FOR INLINE onclick HANDLERS
// (needed because the script loads with defer —
//  functions must be on window before clicks fire)
// ============================================
window.switchPage        = switchPage;
window.toggleSidebar     = toggleSidebar;
window.clearAlerts       = clearAlerts;
window.modalOpen         = modalOpen;
window.modalClose        = modalClose;
window.modalAck          = modalAck;
window.ackAlert          = ackAlert;
window.testFlash         = testFlash;
window.clearLog          = clearLog;
window.btScan            = btScan;
window.btDisconnect      = btDisconnect;
window.btConnectDevice   = btConnectDevice;
window.sendCmd           = sendCmd;
window.sendCustomCmd     = sendCustomCmd;
window.triggerAlert      = triggerAlert;
window.toggleSource      = toggleSource;
window.simulateEmailAlert = simulateEmailAlert;
window.resetSettings     = resetSettings;
window.fetchGmail        = fetchGmail;
window.clearGmailFeed    = clearGmailFeed;
window.openGmailMessage  = openGmailMessage;

// ============================================
// DOM-READY INITIALISATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  // Clock
  const clockEl = document.getElementById('clock');
  if (clockEl) clockEl.textContent = nowTime();
  setInterval(() => {
    const el = document.getElementById('clock');
    if (el) el.textContent = nowTime();
  }, 1000);

  // App startup
  buildMicroGrid();
  buildChart();
  renderAlerts();
  setDisconnectedUI();
  renderDeviceEmptyState('No device found');
  setInterval(buildChart, 60000);
  switchPage('dashboard');

  // Gmail button wiring (done here so elements are guaranteed to exist)
  const signInBtn = document.getElementById("googleSignInBtn");
  if (signInBtn) {
    signInBtn.onclick = () => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
          gmailToken = tokenResponse.access_token;
          document.getElementById("gmailStatus").textContent = "Connected";
          fetchGmailProfile();
          fetchGmail();
          startPolling();
        }
      });
      tokenClient.requestAccessToken();
    };
  }

  const signOutBtn = document.getElementById("googleSignOutBtn");
  if (signOutBtn) {
    signOutBtn.onclick = () => {
      gmailToken = null;
      gmailEmail = null;
      gmailKnownMessageIds.clear();
      gmailBaselineCaptured = false;
      document.getElementById("gmailStatus").textContent = "Disconnected";
      document.getElementById("connectedEmail").textContent = "—";
      document.getElementById("googleSignInBtn").style.display = "inline-block";
      document.getElementById("googleSignOutBtn").style.display = "none";
      document.getElementById("gmailFeed").innerHTML =
        `<div class="empty"><p>No emails loaded</p></div>`;
      updateCounts();
    };
  }
});

// Fetch emails from Gmail API
async function fetchGmail() {
  if (!gmailToken) return;
  try {
    const res = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread',
      {
        headers: {
          Authorization: `Bearer ${gmailToken}`
        }
      }
    );
    const data = await res.json();
    const messages = data.messages || [];
    const newlyAddedIds = new Set();

    if (!gmailBaselineCaptured) {
      messages.forEach(msg => gmailKnownMessageIds.add(msg.id));
      gmailBaselineCaptured = true;
    } else {
      messages.forEach(msg => {
        if (!gmailKnownMessageIds.has(msg.id)) {
          gmailKnownMessageIds.add(msg.id);
          newlyAddedIds.add(msg.id);
        }
      });
    }

    if (messages.length === 0) {
      document.getElementById('gmailFeed').innerHTML = `<div class="empty"><div class="ei">📭</div><p>No unread emails</p></div>`;
      return;
    }
    
    // Fetch details for each message
    const emailsList = await Promise.all(
      messages.slice(0, 10).map(msg => 
        fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
          headers: { Authorization: `Bearer ${gmailToken}` }
        }).then(r => r.json())
      )
    );
    
    gmailMessages = emailsList.map(msg => {
      const headers = msg.payload.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const internalDate = msg.internalDate ? parseInt(msg.internalDate, 10) : null;
      const sentAt = internalDate ? new Date(internalDate).toLocaleString('en-SG', { hour12: false }) : date;
      const content = getMessageBody(msg.payload) || msg.snippet || '(No preview available)';
      const escapedId = msg.id.replace(/'/g, "\\'");
      const safeSubject = escapeHtml(subject);
      const safeFrom = escapeHtml(from);
      const isNewAfterSignIn = newlyAddedIds.has(msg.id);
      if (isNewAfterSignIn) {
        if (btConnected) {
          sendCmd('EMAIL:LOW');
        } else {
          addAlert({
            id: msg.id,
            icon: '✉️',
            lvl: 'warn',
            title: 'Email received',
            src: 'Gmail',
            urgency: 'l',
            unread: true,
            body: `New email from ${from}. Waiting for micro:bit connection.`
          });
        }
      }
      return {
        id: msg.id,
        subject,
        from,
        sentAt,
        content,
        alertLevel: 'LOW',
        sentToMicrobit: isNewAfterSignIn && btConnected,
        displayHtml: `
          <div class="gmail-item" onclick="openGmailMessage('${escapedId}')">
            <div class="gmail-subject">${safeSubject}</div>
            <div class="gmail-meta">From: ${safeFrom}</div>
          </div>
        `
      };
    });

    const html = gmailMessages.map(m => m.displayHtml).join('');
    document.getElementById('gmailFeed').innerHTML = html;
  } catch (e) {
    console.error('Gmail fetch error:', e);
  }
}

function clearGmailFeed() {
  const feed = document.getElementById('gmailFeed');
  if (!feed) return;
  gmailMessages = [];
  feed.innerHTML = `<div class="empty"><div class="ei">📭</div><p>Gmail feed cleared</p></div>`;
}

function openGmailMessage(id) {
  const message = gmailMessages.find(m => m.id === id);
  if (!message) return;
  currentGmailId = id;
  const relatedAlert = alerts.find(a => a.id === id);
  currentAlertId = relatedAlert ? relatedAlert.id : null;
  document.getElementById('mIcon').textContent = '✉️';
  document.getElementById('mTitle').textContent = message.subject;
  document.getElementById('mSub').textContent = `${message.from} · ${message.sentAt}`;
  document.getElementById('mBody').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;font-family:var(--mono);font-size:12px;color:var(--text);">
      <div><strong>Subject:</strong> ${escapeHtml(message.subject)}</div>
      <div><strong>From:</strong> ${escapeHtml(message.from)}</div>
      <div><strong>Sent At:</strong> ${escapeHtml(message.sentAt)}</div>
      <div><strong>Alert Level:</strong> ${message.alertLevel}</div>
      <div><strong>Signal sent:</strong> ${message.sentToMicrobit ? 'Yes (EMAIL:LOW)' : 'No'}</div>
      <div style="padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);white-space:pre-wrap;">${escapeHtml(message.content)}</div>
    </div>
  `;
  document.getElementById('alertModal').classList.add('open');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMessageBody(payload) {
  if (!payload) return '';
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = getMessageBody(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeGmailBase64(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return decodeGmailBase64(payload.body.data).replace(/<[^>]+>/g, '');
  }
  if (payload.body && payload.body.data) {
    return decodeGmailBase64(payload.body.data);
  }
  return '';
}

function decodeGmailBase64(data) {
  try {
    const decoded = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    return decodeURIComponent(decoded.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
  } catch (e) {
    return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  }
}
