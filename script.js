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

// Nordic UART Service UUIDs — these match what micro:bit V2 actually advertises
// Confirmed via chrome://bluetooth-internals
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // micro:bit → app (notify)
const NUS_RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // app → micro:bit (write)

// Alert source configuration
const sources = { email: true, call: true, message: true, notif: false };
const sourceConfig = {
  call:    { icon: '📞', title: 'Incoming Call',  urgency: 'h', cmd: 'CALL:HIGH' },
  message: { icon: '💬', title: 'New Message',    urgency: 'm', cmd: 'MSG:MED'   },
  email:   { icon: '✉️', title: 'Email Received', urgency: 'l', cmd: 'EMAIL:LOW' },
  notif:   { icon: '🔔', title: 'Notification',   urgency: 'l', cmd: 'NOTIF:LOW' }
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
function nowTime() {
  return new Date().toLocaleTimeString('en-SG', { hour12: false });
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', sidebarCollapsed);
}

const pageMeta = {
  dashboard: ['Dashboard', 'PHONE ALERTS → MICRO:BIT'],
  bluetooth:  ['Bluetooth', 'DEVICE CONFIGURATION'],
  sources:    ['Sources',   'CONFIGURE INPUT FILTERS'],
  settings:   ['Settings',  'PREFERENCES & DEVICE']
};

function switchPage(name, navEl) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const targetNav = navEl && navEl.dataset && navEl.dataset.page
    ? navEl
    : document.querySelector(`.nav-item[data-page="${name}"]`);
  if (targetNav) targetNav.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  if (page) page.classList.add('active');
  const pageTitle = name.charAt(0).toUpperCase() + name.slice(1);
  const labelEl = document.getElementById('pageLabel');
  if (labelEl) labelEl.textContent = pageTitle;
  const pageTitleEl = document.getElementById('pageTitle');
  if (pageTitleEl) pageTitleEl.textContent = pageTitle;
  const [, sub] = pageMeta[name] || ['', ''];
  const pageSubEl = document.getElementById('pageSub');
  if (pageSubEl) pageSubEl.textContent = sub;
}

// ============================================
// ALERT MANAGEMENT
// ============================================
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
  const total      = document.getElementById('totalAlerts');
  const unread     = document.getElementById('unreadAlerts');
  const crit       = document.getElementById('critAlerts');
  const badge      = document.getElementById('navBadge');
  const unreadCount = alerts.filter(a => a.unread).length;
  if (total)  total.textContent  = alertCount;
  if (unread) unread.textContent = unreadCount;
  if (crit)   crit.textContent   = btConnected ? 1 : 0;
  if (badge)  badge.style.display = unreadCount > 0 ? '' : 'none';
}

function clearAlerts() {
  alerts = [];
  alertCount = 0;
  eventHistory = [];
  renderAlerts();
  buildChart();
}

function recordEvent() {
  const now = Date.now();
  eventHistory.push(now);
  eventHistory = eventHistory.filter(ts => ts >= now - 3600000);
}

function addAlert(a) {
  alertCount += 1;
  const alert = { id: a.id || Date.now(), time: nowTime(), ...a };
  alerts.unshift(alert);
  recordEvent();
  renderAlerts();
  buildChart();
}

// ============================================
// MODAL DIALOG
// ============================================
function modalOpen(id) {
  const a = alerts.find(x => x.id === id);
  if (!a) return;
  currentAlertId = id;
  document.getElementById('mIcon').textContent  = a.icon;
  document.getElementById('mTitle').textContent = a.title;
  document.getElementById('mSub').textContent   = `${a.src} · Today at ${a.time}`;
  document.getElementById('mBody').textContent  = a.body;
  document.getElementById('alertModal').classList.add('open');
}

function modalClose(e) {
  if (!e || e.target.id === 'alertModal')
    document.getElementById('alertModal').classList.remove('open');
}

function modalAck() {
  const id = currentAlertId || currentGmailId;
  if (id) {
    alerts = alerts.map(a => a.id === id ? { ...a, unread: false } : a);
    renderAlerts();
  }
  currentAlertId = null;
  currentGmailId = null;
  document.getElementById('alertModal').classList.remove('open');
}

function ackAlert(id, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (id == null) return;
  alerts = alerts.map(a => a.id === id ? { ...a, unread: false } : a);
  renderAlerts();
}

// ============================================
// MICRO:BIT DISPLAY
// ============================================
function buildMicroGrid() {
  const el = document.getElementById('ledMatrix');
  if (!el) return;
  el.innerHTML = ['BT', 'RX', 'TX', 'OK'].map(x => `<div class="led-cell">${x}</div>`).join('');
}

function testFlash() {
  screenFlash('#00d4ff');
  sendCmd('TEST:ALL');
}

function screenFlash(color = '#00d4ff') {
  const f = document.getElementById('flashOverlay');
  if (!f) return;
  f.style.background = color;
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
  setTimeout(() => f.classList.remove('go'), 350);
}

// ============================================
// BLUETOOTH LOGGING
// ============================================
function btLog(msg, cls = '') {
  const log = document.getElementById('btLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'log-line ' + (cls || '');
  line.innerHTML = `<span class="log-time">${nowTime()}</span>${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  const log = document.getElementById('btLog');
  if (!log) return;
  log.innerHTML = '';
  btLog('Log cleared.', 'info');
}

// ============================================
// UART NOTIFICATION HANDLER
// ============================================
function handleUartNotification(event) {
  const value = event.target.value;
  if (!value) return;
  uartBuffer += new TextDecoder().decode(value);
  let idx;
  while ((idx = uartBuffer.indexOf('\n')) !== -1) {
    const message = uartBuffer.slice(0, idx).trim();
    uartBuffer = uartBuffer.slice(idx + 1);
    if (!message) continue;
    btLog(`RX ← ${message}`, 'info');
  }
}

// ============================================
// BLUETOOTH DEVICE UI HELPERS
// ============================================
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

// ============================================
// BLUETOOTH SCAN
// ============================================
async function btScan() {
  btLog('Scanning for Bluetooth devices…', 'info');
  document.getElementById('btStateTitle').textContent = 'Scanning…';
  document.getElementById('btStateSub').textContent   = 'Looking for nearby micro:bit devices';
  document.getElementById('btIconWrap').className     = 'bt-orb-ring disconnected-icon';

  if (!navigator.bluetooth) {
    btLog('Web Bluetooth is not supported in this browser.', 'err');
    document.getElementById('btStateTitle').textContent = 'Bluetooth unavailable';
    document.getElementById('btStateSub').textContent   = 'Use Chrome or Edge';
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
      btLog('Filtered scan found nothing, trying broad scan…', 'info');
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
      } catch (innerErr) {
        btLog(`Scan failed: ${innerErr.message}`, 'err');
        renderDeviceEmptyState('Scan failed');
        setDisconnectedUI();
        return;
      }
    }
    btLog(`Scan error: ${e.message}`, 'err');
    renderDeviceEmptyState('Scan failed');
    setDisconnectedUI();
  }
}

// ============================================
// BLUETOOTH CONNECT  ← the fixed version
// ============================================
async function btConnectDevice(dev) {
  if (!dev) return;
  btLog(`Connecting to ${dev.name || 'device'}…`, 'info');

  try {
    // Step 1 — connect GATT
    let server = await dev.gatt.connect();
    btLog('GATT connected, discovering services…', 'info');

    // Step 2 — get the UART service, reconnecting if Windows drops it
    // Windows BLE driver sometimes drops GATT immediately after connect.
    // We catch that, reconnect, and retry up to 10 times.
    let service = null;
    const MAX_ATTEMPTS = 10;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        // Reconnect if the server dropped between attempts
        if (!server.connected) {
          btLog(`GATT dropped, reconnecting (attempt ${i + 1}/${MAX_ATTEMPTS})…`, 'info');
          server = await dev.gatt.connect();
        }
        service = await server.getPrimaryService(NUS_SERVICE_UUID);
        btLog(`Service found on attempt ${i + 1} ✓`, 'ok');
        break;
      } catch (err) {
        btLog(`Attempt ${i + 1}/${MAX_ATTEMPTS}: ${err.message}`, 'info');
        if (i < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, 600));
        } else {
          throw new Error(
            'Could not find UART service after ' + MAX_ATTEMPTS + ' attempts. ' +
            'Make sure: (1) No Pairing Required is set in MakeCode, ' +
            '(2) old pairing is removed from Windows Bluetooth settings AND Device Manager.'
          );
        }
      }
    }

    // Step 3 — get characteristics
    // NUS_TX_CHAR (6e400002) = micro:bit transmits → app subscribes (notify)
    // NUS_RX_CHAR (6e400003) = app writes → micro:bit receives (write)
    btNotifyChar = await service.getCharacteristic(NUS_TX_CHAR_UUID); // notify
    btTx         = await service.getCharacteristic(NUS_RX_CHAR_UUID); // write

    // Step 4 — subscribe to notifications from micro:bit
    await btNotifyChar.startNotifications();
    btNotifyChar.addEventListener('characteristicvaluechanged', handleUartNotification);

    // Step 5 — mark connected
    btDevice    = dev;
    btConnected = true;

    setConnectedUI(dev.name || 'micro:bit');
    btLog('Connected ✓', 'ok');

    // Step 6 — ping to verify two-way comms
    await sendCmd('PING');

    // Step 7 — handle disconnect
    dev.addEventListener('gattserverdisconnected', () => {
      btConnected  = false;
      btTx         = null;
      btNotifyChar = null;
      btDevice     = null;
      uartBuffer   = '';
      setDisconnectedUI();
      addAlert({
        icon: '⚠️', lvl: 'warn', title: 'Bluetooth disconnected',
        src: 'Bluetooth', urgency: 'm', unread: false,
        body: 'The micro:bit was disconnected.'
      });
      btLog('Disconnected', 'err');
    });

  } catch (e) {
    btLog(`Connection failed: ${e.message}`, 'err');
    addAlert({
      icon: '❌', lvl: 'crit', title: 'Bluetooth connection failed',
      src: 'Bluetooth', urgency: 'h', unread: false,
      body: e.message
    });
    setDisconnectedUI();
  }
}

// ============================================
// BLUETOOTH UI STATE
// ============================================
function setConnectedUI(name) {
  document.getElementById('btStateTitle').textContent = 'Connected';
  document.getElementById('btStateSub').textContent   = name;
  document.getElementById('btIconWrap').className     = 'bt-orb-ring connected-icon';
  document.getElementById('btScanBtn').style.display       = 'none';
  document.getElementById('btDisconnectBtn').style.display = '';
  const cmdNote = document.getElementById('btCmdNote');
  if (cmdNote) cmdNote.style.display = 'none';
  document.getElementById('btInfoStatus').textContent  = 'Connected ✓';
  document.getElementById('btInfoStatus').style.color  = 'var(--ok)';
  const chip      = document.getElementById('btChip');
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

function setDisconnectedUI() {
  document.getElementById('btStateTitle').textContent = 'No Device Connected';
  document.getElementById('btStateSub').textContent   = 'Scan to find your micro:bit';
  document.getElementById('btIconWrap').className     = 'bt-orb-ring disconnected-icon';
  document.getElementById('btScanBtn').style.display       = '';
  document.getElementById('btDisconnectBtn').style.display = 'none';
  const cmdNote = document.getElementById('btCmdNote');
  if (cmdNote) cmdNote.style.display = '';
  document.getElementById('btInfoStatus').textContent = 'Disconnected';
  document.getElementById('btInfoStatus').style.color = 'var(--crit)';
  const chip      = document.getElementById('btChip');
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

async function btDisconnect() {
  if (btNotifyChar) {
    btNotifyChar.removeEventListener('characteristicvaluechanged', handleUartNotification);
    btNotifyChar = null;
  }
  if (btDevice && btDevice.gatt.connected) {
    btDevice.gatt.disconnect();
  }
  btConnected = false;
  btDevice    = null;
  btTx        = null;
  uartBuffer  = '';
  setDisconnectedUI();
  btLog('Disconnected.', 'info');
  renderDeviceEmptyState('No device connected');
}

// ============================================
// COMMAND SENDING
// ============================================
async function sendCmd(cmd) {
  if (!btConnected || !btTx || !(btDevice && btDevice.gatt && btDevice.gatt.connected)) {
    btLog('Not connected — command not sent.', 'err');
    return;
  }
  btLog(`TX → ${cmd}`, 'info');
  try {
    await btTx.writeValue(new TextEncoder().encode(cmd + '\n'));
    btLog(`Sent: ${cmd}`, 'ok');
  } catch (e) {
    btLog(`Send failed: ${e.message}`, 'err');
    return;
  }
  const [type, urg, src] = cmd.split(':');
  if (type && type !== 'TEST' && type !== 'PING') triggerAlert(type.toLowerCase(), urg || 'l', src || 'PHONE');
  if (type === 'TEST') screenFlash('#00d4ff');
}

function sendCustomCmd() {
  const v = document.getElementById('customCmd').value.trim();
  if (v) sendCmd(v);
}

// ============================================
// ALERT TRIGGERING & SOURCES
// ============================================
function triggerAlert(type, urgency = 'l', src = 'PHONE') {
  const cfg  = sourceConfig[type.toLowerCase()] || { icon: '🔔', title: 'Alert', urgency: 'l' };
  const body = `${cfg.title} from ${src}. Command sent to micro:bit: ${type.toUpperCase()}:${urgency.toUpperCase()}`;
  addAlert({
    icon: cfg.icon,
    lvl:  urgency === 'h' ? 'crit' : urgency === 'm' ? 'warn' : 'info',
    title: cfg.title,
    src, time: nowTime(), urgency, unread: true, body
  });
  screenFlash(urgency === 'h' ? '#ff4757' : urgency === 'm' ? '#ffb340' : '#00d4ff');
}

function toggleSource(name, tog) {
  sources[name] = tog.classList.toggle('on');
}

function simulateEmailAlert() {
  if (!sources.email) return;
  const sender  = document.getElementById('emailSender').value.trim()  || 'name@example.com';
  const keyword = document.getElementById('emailKeyword').value.trim();
  const cmd     = document.getElementById('emailCmd').value.trim()     || 'EMAIL:LOW:MAIL';
  triggerAlert('email', 'l', sender);
  btLog(`Email matched: ${sender}${keyword ? ` | keyword: ${keyword}` : ''}`, 'info');
  if (btConnected) sendCmd(cmd);
}

function resetSettings() {
  if (confirm('Reset all settings to defaults?')) location.reload();
}

// ============================================
// ACTIVITY CHART
// ============================================
function buildChart() {
  const el = document.getElementById('miniChart');
  if (!el) return;
  const now       = Date.now();
  const hourAgo   = now - 3600000;
  const bucketSize = 3600000 / 8;
  const buckets   = Array.from({ length: 8 }, () => 0);
  eventHistory.forEach(ts => {
    if (ts >= hourAgo) {
      let i = Math.floor((ts - hourAgo) / bucketSize);
      buckets[Math.min(Math.max(i, 0), 7)] += 1;
    }
  });
  const max = Math.max(...buckets, 1);
  el.innerHTML = buckets.map(count =>
    `<div class="bar ${count > 0 ? 'hi' : ''}" style="height:${Math.round(count / max * 100)}%"></div>`
  ).join('');
}

// ============================================
// GMAIL INTEGRATION
// ============================================
let gmailToken  = null;
let gmailEmail  = null;
let tokenClient;

const GOOGLE_CLIENT_ID = "768854227704-2mc6bip356pa56ejomb9lss8noc1b82c.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

async function fetchGmailProfile() {
  const res  = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${gmailToken}` } });
  const data = await res.json();
  gmailEmail = data.emailAddress;
  document.getElementById("connectedEmail").textContent      = gmailEmail;
  document.getElementById("googleSignInBtn").style.display   = "none";
  document.getElementById("googleSignOutBtn").style.display  = "inline-block";
}

function startPolling() {
  setInterval(fetchGmail, 15000);
}

async function fetchGmail() {
  if (!gmailToken) return;
  try {
    const res      = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread',
      { headers: { Authorization: `Bearer ${gmailToken}` } });
    const data     = await res.json();
    const messages = data.messages || [];
    const newIds   = new Set();

    if (!gmailBaselineCaptured) {
      messages.forEach(msg => gmailKnownMessageIds.add(msg.id));
      gmailBaselineCaptured = true;
    } else {
      messages.forEach(msg => {
        if (!gmailKnownMessageIds.has(msg.id)) {
          gmailKnownMessageIds.add(msg.id);
          newIds.add(msg.id);
        }
      });
    }

    if (!messages.length) {
      document.getElementById('gmailFeed').innerHTML =
        `<div class="empty"><div class="ei">📭</div><p>No unread emails</p></div>`;
      return;
    }

    const emailsList = await Promise.all(
      messages.slice(0, 10).map(msg =>
        fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
          { headers: { Authorization: `Bearer ${gmailToken}` } }).then(r => r.json())
      )
    );

    gmailMessages = emailsList.map(msg => {
      const headers    = msg.payload.headers || [];
      const subject    = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
      const from       = headers.find(h => h.name === 'From')?.value    || 'Unknown';
      const date       = headers.find(h => h.name === 'Date')?.value    || '';
      const internalDate = msg.internalDate ? parseInt(msg.internalDate, 10) : null;
      const sentAt     = internalDate
        ? new Date(internalDate).toLocaleString('en-SG', { hour12: false })
        : date;
      const content    = getMessageBody(msg.payload) || msg.snippet || '(No preview available)';
      const escapedId  = msg.id.replace(/'/g, "\\'");
      const isNew      = newIds.has(msg.id);

      if (isNew) {
        if (btConnected) {
          sendCmd('EMAIL:LOW');
        } else {
          addAlert({
            id: msg.id, icon: '✉️', lvl: 'warn', title: 'Email received',
            src: 'Gmail', urgency: 'l', unread: true,
            body: `New email from ${from}. Waiting for micro:bit connection.`
          });
        }
      }

      return {
        id: msg.id, subject, from, sentAt, content,
        alertLevel: 'LOW',
        sentToMicrobit: isNew && btConnected,
        displayHtml: `
          <div class="gmail-item" onclick="openGmailMessage('${escapedId}')">
            <div class="gmail-subject">${escapeHtml(subject)}</div>
            <div class="gmail-meta">From: ${escapeHtml(from)}</div>
          </div>
        `
      };
    });

    document.getElementById('gmailFeed').innerHTML = gmailMessages.map(m => m.displayHtml).join('');
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
  const related  = alerts.find(a => a.id === id);
  currentAlertId = related ? related.id : null;
  document.getElementById('mIcon').textContent  = '✉️';
  document.getElementById('mTitle').textContent = message.subject;
  document.getElementById('mSub').textContent   = `${message.from} · ${message.sentAt}`;
  document.getElementById('mBody').innerHTML    = `
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
  return String(text)
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
  if (payload.mimeType === 'text/plain' && payload.body?.data)
    return decodeGmailBase64(payload.body.data);
  if (payload.mimeType === 'text/html' && payload.body?.data)
    return decodeGmailBase64(payload.body.data).replace(/<[^>]+>/g, '');
  if (payload.body?.data)
    return decodeGmailBase64(payload.body.data);
  return '';
}

function decodeGmailBase64(data) {
  try {
    const decoded = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    return decodeURIComponent(
      decoded.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
  } catch {
    return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  }
}

// ============================================
// EXPOSE GLOBALS FOR INLINE onclick HANDLERS
// ============================================
window.switchPage         = switchPage;
window.toggleSidebar      = toggleSidebar;
window.clearAlerts        = clearAlerts;
window.modalOpen          = modalOpen;
window.modalClose         = modalClose;
window.modalAck           = modalAck;
window.ackAlert           = ackAlert;
window.testFlash          = testFlash;
window.clearLog           = clearLog;
window.btScan             = btScan;
window.btDisconnect       = btDisconnect;
window.btConnectDevice    = btConnectDevice;
window.sendCmd            = sendCmd;
window.sendCustomCmd      = sendCustomCmd;
window.triggerAlert       = triggerAlert;
window.toggleSource       = toggleSource;
window.simulateEmailAlert = simulateEmailAlert;
window.resetSettings      = resetSettings;
window.fetchGmail         = fetchGmail;
window.clearGmailFeed     = clearGmailFeed;
window.openGmailMessage   = openGmailMessage;

// ============================================
// DOM-READY INITIALISATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  const clockEl = document.getElementById('clock');
  if (clockEl) clockEl.textContent = nowTime();
  setInterval(() => {
    const el = document.getElementById('clock');
    if (el) el.textContent = nowTime();
  }, 1000);

  buildMicroGrid();
  buildChart();
  renderAlerts();
  setDisconnectedUI();
  renderDeviceEmptyState('No device found');
  setInterval(buildChart, 60000);
  switchPage('dashboard');

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
      gmailToken            = null;
      gmailEmail            = null;
      gmailBaselineCaptured = false;
      gmailKnownMessageIds.clear();
      document.getElementById("gmailStatus").textContent        = "Disconnected";
      document.getElementById("connectedEmail").textContent     = "—";
      document.getElementById("googleSignInBtn").style.display  = "inline-block";
      document.getElementById("googleSignOutBtn").style.display = "none";
      document.getElementById("gmailFeed").innerHTML =
        `<div class="empty"><p>No emails loaded</p></div>`;
      updateCounts();
    };
  }
});
