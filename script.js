var firebaseConfig = {
  apiKey: "AIzaSyCPcCEaPTTG4mCWZq3mz4W7CkRJ3fipaqw",
  authDomain: "omnipay-96b87.firebaseapp.com",
  projectId: "omnipay-96b87",
  storageBucket: "omnipay-96b87.firebasestorage.app",
  messagingSenderId: "1041180202236",
  appId: "1:1041180202236:web:187a757e0852ff35a4f379",
  measurementId: "G-6S5F8MT69H"
};

var fbApp, auth, db;
var USERS_COLLECTION = 'users';
var USERNAME_LOOKUP_COLLECTION = 'usernames';
try {
  fbApp = firebase.initializeApp(firebaseConfig);
  auth  = firebase.auth();
  db    = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(function(){});
} catch(e) { console.warn('Firebase init error:', e); }

function makeHexSalt(bytes) {
  var output = '';
  var values = new Uint8Array(bytes);
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    window.crypto.getRandomValues(values);
  } else {
    for (var i = 0; i < values.length; i++) values[i] = Math.floor(Math.random() * 256);
  }
  for (var j = 0; j < values.length; j++) output += values[j].toString(16).padStart(2, '0');
  return output;
}

async function sha256Hex(value) {
  if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
    throw new Error('Secure browser cryptography is unavailable. Open OmniPay over HTTPS and try again.');
  }
  var bytes = new TextEncoder().encode(String(value));
  var digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(function(byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

async function createSecretRecord(value) {
  var salt = randomBytes(16);
  var derivedBytes = await deriveSecretBytes(value, salt, SECRET_HASH_ITERATIONS);
  var probe = await window.crypto.subtle.sign(
    'HMAC',
    await window.crypto.subtle.importKey(
      'raw',
      derivedBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ),
    new TextEncoder().encode('OmniPay secret record')
  );
  return {
    hash: SECRET_HASH_PREFIX + SECRET_HASH_ITERATIONS + '$' + bytesToHex(new Uint8Array(probe)),
    salt: bytesToHex(salt)
  };
}

async function verifySecret(value, hash, salt) {
  if (!hash || !salt) return false;
  if (String(hash).indexOf(SECRET_HASH_PREFIX) === 0) {
    var parts = String(hash).split('$');
    var iterations = parseInt(parts[1], 10);
    var expected = parts[2] || '';
    if (!iterations || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
    if (!window.crypto || !window.crypto.subtle) return false;
    var saltBytes = hexToBytes(salt);
    var rawKey = await deriveSecretBytes(value, saltBytes, iterations);
    var hmacKey = await window.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    var actual = bytesToHex(new Uint8Array(await window.crypto.subtle.sign(
      'HMAC',
      hmacKey,
      new TextEncoder().encode('OmniPay secret record')
    )));
    return actual === expected;
  }
  return (await sha256Hex(salt + ':' + value)) === hash;
}

function setFbStatus(type, msg) {
  var el = document.getElementById('fbStatus');
  if (!el) return;
  el.className = 'fb-status ' + type;
  el.textContent = msg;
}

async function usernameExistsInFirestore(username) {
  return false;
}

async function nameExistsInFirestore(fullName) {
  return false;
}

async function getUserProfileByUsername(username) {
  if (!auth || !auth.currentUser || !db) return null;
  try {
    var doc = await db.collection(USERS_COLLECTION).doc(auth.currentUser.uid).get();
    return doc.exists ? doc.data() : null;
  } catch(e) { return null; }
}

async function getUserProfileByEmail(email) {
  return null;
}

var LAST_FIRESTORE_ERROR = null;

var SECRET_HASH_PREFIX = 'pbkdf2-sha256$';
var SECRET_HASH_ITERATIONS = 150000;

function safeText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function randomBytes(bytes) {
  var values = new Uint8Array(bytes);
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
    throw new Error('Secure browser randomness is unavailable. Open OmniPay over HTTPS and try again.');
  }
  window.crypto.getRandomValues(values);
  return values;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(function(byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function hexToBytes(hex) {
  var clean = String(hex || '');
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) return new Uint8Array(0);
  var bytes = new Uint8Array(clean.length / 2);
  for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToBase64(bytes) {
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value) {
  var binary = atob(String(value || ''));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveSecretKey(password, salt) {
  if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
    throw new Error('Secure browser cryptography is unavailable. Open OmniPay over HTTPS and try again.');
  }
  var material = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: SECRET_HASH_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveSecretBytes(password, salt, iterations) {
  if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
    throw new Error('Secure browser cryptography is unavailable. Open OmniPay over HTTPS and try again.');
  }
  var material = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  var bits = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations || SECRET_HASH_ITERATIONS, hash: 'SHA-256' },
    material,
    256
  );
  return new Uint8Array(bits);
}

async function encryptWalletSecret(secret, password) {
  var salt = randomBytes(16);
  var iv = randomBytes(12);
  var key = await deriveSecretKey(password, salt);
  var encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    new TextEncoder().encode(String(secret))
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    salt: bytesToHex(salt),
    iv: bytesToBase64(iv)
  };
}

async function decryptWalletSecret(ciphertext, saltHex, ivBase64, password) {
  if (!ciphertext || !saltHex || !ivBase64 || !password) return '';
  try {
    var key = await deriveSecretKey(password, hexToBytes(saltHex));
    var decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivBase64) },
      key,
      base64ToBytes(ciphertext)
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return '';
  }
}

async function saveUserProfile(uid, data) {
  if (!db) { LAST_FIRESTORE_ERROR = { code:'firestore/no-db', message:'Firestore not initialized' }; return false; }
  if (!auth || !auth.currentUser || auth.currentUser.uid !== uid) {
    LAST_FIRESTORE_ERROR = { code:'auth/not-authenticated', message:'Authenticated user is required' };
    return false;
  }
  try {
    await db.collection(USERS_COLLECTION).doc(uid).set(Object.assign({}, data, {
      uid: uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }));
    LAST_FIRESTORE_ERROR = null;
    return true;
  } catch(e) {
    console.warn('Firestore save error:', e);
    LAST_FIRESTORE_ERROR = { code: e.code || 'unknown', message: e.message || String(e) };
    return false;
  }
}

async function updateUserProfile(uid, fields) {
  if (!db) { LAST_FIRESTORE_ERROR = { code:'firestore/no-db', message:'Firestore not initialized' }; return false; }
  if (!auth || !auth.currentUser || auth.currentUser.uid !== uid) {
    LAST_FIRESTORE_ERROR = { code:'auth/not-authenticated', message:'Authenticated user is required' };
    return false;
  }
  try {
    await db.collection(USERS_COLLECTION).doc(uid).update(Object.assign({}, fields, {
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }));
    LAST_FIRESTORE_ERROR = null;
    return true;
  } catch(e) {
    console.warn('Firestore update error:', e);
    LAST_FIRESTORE_ERROR = { code: e.code || 'unknown', message: e.message || String(e) };
    return false;
  }
}

function generateStellarKeypairReal() {
  if (typeof StellarSdk !== 'undefined' && StellarSdk.Keypair) {
    try {
      var kp = StellarSdk.Keypair.random();
      return { publicKey: kp.publicKey(), secretKey: kp.secret() };
    } catch(e) {}
  }
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var pub = 'G', sec = 'S';
  for (var i = 0; i < 55; i++) { pub += chars[Math.floor(Math.random()*chars.length)]; sec += chars[Math.floor(Math.random()*chars.length)]; }
  return { publicKey: pub, secretKey: sec };
}
function generateStellarPublicKey() { return generateStellarKeypairReal().publicKey; }
function generateStellarSecretKey() { return generateStellarKeypairReal().secretKey; }
function generateContractAddress() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var key = 'C';
  for (var i = 0; i < 55; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function normalizeStellarPublicKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toUpperCase();
}

function stellarAddressError(value) {
  var address = normalizeStellarPublicKey(value);
  if (!address) return 'Enter a Stellar public address.';
  if (address.charAt(0) !== 'G') return 'A Stellar public address must start with G.';
  if (address.length !== 56) return 'A Stellar public address must contain exactly 56 characters.';
  if (!/^G[A-Z2-7]{55}$/.test(address)) return 'Use only valid Stellar Base32 characters (A–Z and 2–7).';
  if (typeof StellarSdk !== 'undefined' && StellarSdk.StrKey &&
      typeof StellarSdk.StrKey.isValidEd25519PublicKey === 'function' &&
      !StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    return 'The address checksum is invalid. Copy the complete address again.';
  }
  return 'The Stellar address is invalid. Copy the complete address again.';
}

function isValidStellarPublicKey(value) {
  var address = normalizeStellarPublicKey(value);
  if (!/^G[A-Z2-7]{55}$/.test(address)) return false;

  if (typeof StellarSdk !== 'undefined') {
    try {
      if (StellarSdk.StrKey && typeof StellarSdk.StrKey.isValidEd25519PublicKey === 'function') {
        return StellarSdk.StrKey.isValidEd25519PublicKey(address);
      }
      if (StellarSdk.Keypair && typeof StellarSdk.Keypair.fromPublicKey === 'function') {
        StellarSdk.Keypair.fromPublicKey(address);
        return true;
      }
    } catch (e) {
      return false;
    }
  }

  return true;
}

async function fundTestnetAccount(publicKey) {
  var response = await fetch('https://friendbot.stellar.org/?addr=' + encodeURIComponent(publicKey));
  if (!response.ok) {
    var details = await response.text().catch(function(){ return ''; });
    throw new Error('Friendbot could not fund the sender (HTTP ' + response.status + ')' + (details ? ': ' + details.substring(0, 120) : ''));
  }
  await response.json().catch(function(){ return {}; });
  return true;
}

async function stellarAccountExists(publicKey) {
  var response = await fetch(STELLAR_HORIZON_TESTNET + '/accounts/' + encodeURIComponent(publicKey));
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Horizon could not verify the recipient (HTTP ' + response.status + ')');
  return true;
}

var PENDING_USER = null;

var STATE = {
  isLoggedIn: false,
  uid: null,
  user: { username: '', name: '', phone: '', email: '', type: 'personal' },
  balance: 2500,
  vaultLocked: 0,
  vaultUsesTotal: 1,
  vaultUsesRemaining: 1,
  trustScore: 5,
  isOnline: true,
  offlineMode: true,
  autoSync: true,
  monoCounter: 0,
  pendingTxCount: 0,
  goodTxCount: 0,
  transferMethod: 'QR',
  noncePool: [1,2,3,4,5,6,7,8,9,10],
  usedNonces: [],
  memberSince: '',
  wallet: {
    publicKey: '',
    secretKey: '',
    xlmBalance: 10000,
    contractAddress: ''
  },
  wallets: [],            // [{publicKey, label, xlmBalance, addedAt}]
  activeWalletIndex: 0,
  transactions: [],
  fraudAlerts: [],
  _balanceGraceUntil: 0   // while Date.now() < this, ignore a live-fetched balance that is HIGHER than what we already know (protects against Horizon's brief read-after-write lag right after a send)
};

function getTrustTier(score) {
  if (score <= 25) return { tier:'New',      pct:30, uses:1,  icon:'⚪', color:'#8A8FA8', bg:'rgba(138,143,168,0.2)' };
  if (score <= 50) return { tier:'Building', pct:50, uses:2,  icon:'🟡', color:'#FFA502', bg:'rgba(255,165,2,0.2)' };
  if (score <= 75) return { tier:'Trusted',  pct:65, uses:4,  icon:'🟠', color:'#FF7F00', bg:'rgba(255,127,0,0.2)' };
  return               { tier:'VIP',      pct:80, uses:99, icon:'🟢', color:'#2ED573', bg:'rgba(46,213,115,0.2)' };
}

function showLoading(show, msg) {
  var el = document.getElementById('loadingOverlay');
  var txt = document.getElementById('loadingText');
  if (show) { el.classList.add('show'); if (msg && txt) txt.textContent = msg; }
  else       { el.classList.remove('show'); }
}

function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  var el = document.getElementById(screenId);
  if (el) el.classList.add('active');
}

function navTo(screenId) {
  if (screenId !== 'pay') { try { stopCamera(); } catch(e) {} }
  goTo(screenId);
  document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); });
  var nav = document.getElementById('nav-' + screenId);
  if (nav) nav.classList.add('active');
  if (screenId === 'home')    renderHome();
  if (screenId === 'vault')   renderVault();
  if (screenId === 'history') renderHistory('all');
  if (screenId === 'profile') renderProfile();

  if (screenId === 'pay') { syncSpendableBalance(); _startSendConvAutoRefresh(); }
  else                    { _stopSendConvAutoRefresh(); }
}

function switchSettingsTab(tab, btn) {
  document.querySelectorAll('.settings-tab-btn').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('.settings-panel').forEach(function(p){ p.classList.remove('active'); });
  btn.classList.add('active');
  var panel = document.getElementById('spanel-' + tab);
  if (panel) panel.classList.add('active');
  if (tab === 'profile-edit') populateProfileEditForm();
}

function populateProfileEditForm() {
  var nameParts = STATE.user.name.split(' ');
  var first = nameParts[0] || '';
  var last  = nameParts.slice(1).join(' ') || '';
  document.getElementById('editFirst').value = first;
  document.getElementById('editLast').value  = last;
  document.getElementById('editPhone').value = STATE.user.phone || '';
  document.getElementById('editEmail').value = STATE.user.email || '';
  var typeEl = document.getElementById('editType');
  if (typeEl) typeEl.value = STATE.user.type || 'personal';
}

async function doSaveProfile() {
  var first = document.getElementById('editFirst').value.trim();
  var last  = document.getElementById('editLast').value.trim();
  var phone = document.getElementById('editPhone').value.trim();
  var email = document.getElementById('editEmail').value.trim();
  var type  = document.getElementById('editType').value;

  if (!first || !last) { showAlert('red','⚠️ First and last name are required'); return; }
  if (!phone)           { showAlert('red','⚠️ Mobile number is required'); return; }

  var btn = document.getElementById('saveProfileBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading(true, 'Updating profile…');

  var fullName = first + ' ' + last;

  var updates = {
    name:      fullName,
    nameLower: fullName.toLowerCase(),
    phone:     phone,
    email:     email,
    type:      type
  };

  if (STATE.uid) {
    var profileSaved = await updateUserProfile(STATE.uid, updates);
    if (!profileSaved) {
      showLoading(false);
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save Profile'; }
      showAlert('red', '❌ Could not update the profile. Check your Firestore rules.');
      return;
    }
  }

  STATE.user.name  = fullName;
  STATE.user.phone = phone;
  STATE.user.email = email;
  STATE.user.type  = type;

  showLoading(false);
  if (btn) { btn.disabled = false; btn.textContent = '💾 Save Profile'; }
  renderProfile();
  showAlert('success','✅ Profile updated successfully!');
}

function onRegCountryChange(sel) {
}

function _getCountryConfig(country) {
  var n = (country || '').toLowerCase();
  if (n.indexOf('philippines') !== -1) return { coin: 'PHPC',  sym: '\u20b1',  cur: 'php' };
  if (n.indexOf('indonesia')   !== -1) return { coin: 'USDT',  sym: 'Rp ', cur: 'idr' };
  if (n.indexOf('malaysia')    !== -1) return { coin: 'USDT',  sym: 'RM ', cur: 'myr' };
  if (n.indexOf('singapore')   !== -1) return { coin: 'XSGD',  sym: 'S$',   cur: 'sgd' };
  if (n.indexOf('thailand')    !== -1) return { coin: 'THB',   sym: '\u0e3f',  cur: 'thb' };
  if (n.indexOf('viet')        !== -1) return { coin: 'USDT',  sym: '\u20ab',  cur: 'vnd' };
  if (n.indexOf('japan')       !== -1) return { coin: 'JPYC',  sym: '\u00a5',  cur: 'jpy' };
  if (n.indexOf('korea')       !== -1) return { coin: 'USDT',  sym: '\u20a9',  cur: 'krw' };
  if (n.indexOf('india')       !== -1) return { coin: 'USDT',  sym: '\u20b9',  cur: 'inr' };
  if (n.indexOf('pakistan')    !== -1) return { coin: 'USDT',  sym: 'Rs ',  cur: 'pkr' };
  if (n.indexOf('kazakh')      !== -1) return { coin: 'USDT',  sym: '\u20b8',  cur: 'kzt' };
  if (n.indexOf('uae') !== -1 || n.indexOf('emirates') !== -1) return { coin: 'USDT', sym: 'AED ', cur: 'aed' };
  if (n.indexOf('saudi')       !== -1) return { coin: 'USDT',  sym: 'SAR ', cur: 'sar' };
  if (n.indexOf('bahrain')     !== -1) return { coin: 'USDT',  sym: 'BHD ', cur: 'bhd' };
  if (n.indexOf('australia')   !== -1) return { coin: 'USDT',  sym: 'A$',   cur: 'aud' };
  if (n.indexOf('canada')      !== -1) return { coin: 'USDT',  sym: 'C$',   cur: 'cad' };
  if (n.indexOf('kingdom')     !== -1 || n.indexOf('uk') === n.length - 2) return { coin: 'USDT', sym: '\u00a3', cur: 'gbp' };
  if (n.indexOf('europe') !== -1 || n.indexOf('germany') !== -1 || n.indexOf('france') !== -1 || n.indexOf('italy') !== -1 || n.indexOf('spain') !== -1) return { coin: 'USDT', sym: '\u20ac', cur: 'eur' };
  if (n.indexOf('brazil')      !== -1) return { coin: 'USDT',  sym: 'R$',   cur: 'brl' };
  if (n.indexOf('nigeria')     !== -1) return { coin: 'USDT',  sym: '\u20a6',  cur: 'ngn' };
  if (n.indexOf('turkey')      !== -1) return { coin: 'USDT',  sym: '\u20ba',  cur: 'try' };
  if (n.indexOf('russia')      !== -1) return { coin: 'USDT',  sym: '\u20bd',  cur: 'rub' };
  if (n.indexOf('china')       !== -1) return { coin: 'USDT',  sym: '\u00a5',  cur: 'cny' };
  if (n.indexOf('mexico')      !== -1) return { coin: 'USDT',  sym: 'MX$',  cur: 'mxn' };
  if (n.indexOf('state')       !== -1 || n.indexOf('united states') !== -1) return { coin: 'USDC', sym: '$', cur: 'usd' };
  return { coin: 'USDC', sym: '$', cur: 'usd' };
}

async function _updateXLMConversion(xlmAmt) {
  var convEl = document.getElementById('heroConvText');
  if (!convEl) return;
  var cfg = _getCountryConfig(STATE.user && STATE.user.country);
  convEl.textContent = 'Loading rate...';
  var rate = null;
  try {
    var rc = new AbortController();
    var rt = setTimeout(function(){ rc.abort(); }, 6000);
    var resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=' + cfg.cur, { signal: rc.signal });
    clearTimeout(rt);
    if (resp.ok) {
      var data = await resp.json();
      rate = (data.stellar && data.stellar[cfg.cur]) ? parseFloat(data.stellar[cfg.cur]) : null;
    }
  } catch(_e) {}
  if (rate === null) {
    try {
      var rc2 = new AbortController();
      var rt2 = setTimeout(function(){ rc2.abort(); }, 6000);
      var cur2 = cfg.cur.toUpperCase();
      var resp2 = await fetch('https://min-api.cryptocompare.com/data/price?fsym=XLM&tsyms=' + cur2, { signal: rc2.signal });
      clearTimeout(rt2);
      if (resp2.ok) {
        var data2 = await resp2.json();
        rate = data2[cur2] ? parseFloat(data2[cur2]) : null;
      }
    } catch(_e2) {}
  }
  if (rate !== null) {
    var total    = xlmAmt * rate;
    var decimals = (cfg.cur === 'jpy' || cfg.cur === 'krw' || cfg.cur === 'vnd' || cfg.cur === 'idr') ? 0 : 2;
    var rateStr  = cfg.sym + rate.toLocaleString('en',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
    var totalStr = cfg.sym + total.toLocaleString('en',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
    convEl.textContent = '\u2248 ' + totalStr + ' ' + cfg.coin + ' (1 XLM = ' + rateStr + ')';
  } else {
    convEl.textContent = 'Rate unavailable';
  }
}

async function doLogin() {
  var username = document.getElementById('loginUser').value.trim();
  var password = document.getElementById('loginPass').value;
  if (!username || !password) { showAlert('red','⚠️ Enter username and password'); return; }
  if (!auth || !db) { showAlert('red','❌ Authentication is unavailable. Refresh and try again.'); return; }

  var btn = document.getElementById('loginBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  showLoading(true, 'Signing in…');

  var account = null;
  var credential = null;
  var loginError = null;
  try {
    var lookupDoc = await db.collection(USERNAME_LOOKUP_COLLECTION).doc(username.toLowerCase()).get();
    if (!lookupDoc.exists) throw { code: 'auth/user-not-found' };
    var email = lookupDoc.data().email;
    credential = await auth.signInWithEmailAndPassword(email, password);
    account = await db.collection(USERS_COLLECTION).doc(credential.user.uid).get();
    if (!account.exists) throw new Error('Your account profile is incomplete. Contact support before using this account.');
    account = account.data();
    account.uid = credential.user.uid;
    account._unlockedWalletSecret = await decryptWalletSecret(
      account.walletSecretEncrypted,
      account.walletSecretSalt,
      account.walletSecretIv,
      password
    );
  } catch (e) {
    loginError = e;
    try { if (credential && credential.user) await auth.signOut(); } catch (_) {}
    account = null;
  }

  showLoading(false);
  if (btn) { btn.disabled = false; btn.textContent = 'Sign In →'; }

  if (account) {
    STATE.isLoggedIn = true;
    STATE.uid  = credential.user.uid;
    STATE.user = {
      username: account.username || username,
      name:     account.name     || username,
      phone:    account.phone    || '',
      email:    credential.user.email || account.email || '',
      type:     account.type     || 'personal',
      country:  account.country  || '\U0001f1f5\U0001f1ed Philippines'
    };
    STATE.balance      = account.balance      != null ? account.balance      : 2500;
    STATE.vaultLocked  = account.vaultLocked  != null ? account.vaultLocked  : 0;
    STATE.trustScore   = account.trustScore   != null ? account.trustScore   : 5;
    STATE.wallet = {
      publicKey:       account.walletPublic   || generateStellarPublicKey(),
      secretKey:       account._unlockedWalletSecret || '',
      xlmBalance:      account.xlmBalance     != null ? account.xlmBalance : 10000,
      contractAddress: account.contractAddress || generateContractAddress()
    };
    STATE.memberSince = account.memberSince || 'Jun 2025';
    var t = getTrustTier(STATE.trustScore);
    STATE.vaultUsesTotal     = t.uses === 99 ? 99 : t.uses;
    STATE.vaultUsesRemaining = t.uses === 99 ? 99 : t.uses;
    STATE.transactions       = [];
    STATE.fraudAlerts        = [];
    STATE.pendingTxCount     = 0;
    STATE.goodTxCount        = account.goodTxCount || 0;
    STATE.monoCounter        = account.monoCounter || 0;
    STATE.noncePool          = [1,2,3,4,5,6,7,8,9,10];
    STATE.usedNonces         = [];
    if (!Array.isArray(STATE.wallets) || STATE.wallets.length === 0) {
      STATE.wallets = [{
        publicKey:  STATE.wallet.publicKey,
        label:      'Primary Wallet',
        xlmBalance: STATE.wallet.xlmBalance || 10000,
        addedAt:    Date.now()
      }];
    }
    STATE.activeWalletIndex = 0;

    document.getElementById('bottomNav').style.display = 'flex';
    navTo('home');
    saveSession();
    var firstName = STATE.user.name.split(' ')[0];
    showAlert('success','👋 Welcome back, ' + firstName + '!');
    setFbStatus('connected','🟢 Signed in as ' + firstName);
    startInboxListener(); // begin real-time incoming-payment listener
  } else {
    if (loginError && loginError.code === 'permission-denied') {
      showAlert('red','❌ Login is unavailable. Firestore rules need to allow reading the "usernames" collection.');
    } else {
      showAlert('red','❌ Invalid username or password');
    }
    var passEl = document.getElementById('loginPass');
    passEl.classList.add('error');
    setTimeout(function(){ passEl.classList.remove('error'); }, 2000);
  }
}

async function doForgotPassword() {
  var email    = document.getElementById('forgotEmail').value.trim();

  if (!email)    { showAlert('red','⚠️ Enter your email address'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showAlert('orange','📧 Enter a valid email address'); return; }
  if (!auth) { showAlert('red','❌ Authentication is unavailable. Refresh and try again.'); return; }

  showLoading(true, 'Sending reset link…');
  try {
    await auth.sendPasswordResetEmail(email);
    showLoading(false);
    closeModal('forgotModal');
    document.getElementById('forgotEmail').value = '';
    showAlert('success','✅ If that email is registered, a reset link is on its way.');
  } catch (e) {
    showLoading(false);
    showAlert('red','❌ Could not send the reset link. Check the email and try again.');
  }
}

async function doRegister() {
  var first = document.getElementById('regFirst').value.trim();
  var last  = document.getElementById('regLast').value.trim();
  var user  = document.getElementById('regUser').value.trim();
  var phone = document.getElementById('regPhone').value.trim();
  var email = document.getElementById('regEmail').value.trim();
  var pass  = document.getElementById('regPass').value;
  var pin   = document.getElementById('regPin').value.trim();
  var terms = document.getElementById('regTerms').checked;
  var type  = document.getElementById('regType').value;

  var requiredFields = [
    { id:'regFirst', val:first,  label:'First Name' },
    { id:'regLast',  val:last,   label:'Last Name' },
    { id:'regUser',  val:user,   label:'Username' },
    { id:'regPhone', val:phone,  label:'Mobile Number' },
    { id:'regEmail', val:email,  label:'Email Address' },
    { id:'regPass',  val:pass,   label:'Password' },
    { id:'regPin',   val:pin,    label:'PIN' }
  ];
  var firstEmpty = null;
  requiredFields.forEach(function(f) {
    var el = document.getElementById(f.id);
    if (!f.val) {
      if (el) el.classList.add('error');
      if (!firstEmpty) firstEmpty = { el: el, label: f.label };
    } else {
      if (el) el.classList.remove('error');
    }
  });
  if (firstEmpty) {
    showAlert('red','⚠️ ' + firstEmpty.label + ' is required');
    if (firstEmpty.el) { firstEmpty.el.focus(); firstEmpty.el.scrollIntoView({ behavior:'smooth', block:'center' }); }
    return;
  }
  if (!terms) { showAlert('orange','📋 Please accept the Terms of Service'); return; }
  if (pass.length < 6) { showAlert('orange','🔐 Password must be at least 6 characters'); return; }
  if (!/\d/.test(pass)) { showAlert('orange','🔢 Password must contain at least one number'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showAlert('orange','📧 Enter a valid email address'); return; }
  if (!/^\d{4,6}$/.test(pin)) { document.getElementById('regPin').classList.add('error'); showAlert('orange','🔢 PIN must be 4–6 digits'); return; }

  var btn = document.getElementById('registerBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking availability…'; }
  showLoading(true, 'Checking availability…');

  var fullName = first + ' ' + last;

  showLoading(false);
  if (btn) { btn.disabled = false; btn.textContent = 'Create Account & Generate Wallet →'; }

  if (!auth || typeof StellarSdk === 'undefined' || !StellarSdk.Keypair) {
    showAlert('red', '❌ Required services are not loaded. Refresh the page and try again.');
    return;
  }

  var _kp     = generateStellarKeypairReal();
  var pubKey   = _kp.publicKey;
  var secKey   = _kp.secretKey;
  var walletSecretRecord;
  try {
    walletSecretRecord = await encryptWalletSecret(secKey, pass);
  } catch (e) {
    showAlert('red', '❌ Could not protect the wallet key. Try again over HTTPS.');
    return;
  }
  var pinRecord;
  try {
    pinRecord = await createSecretRecord(pin);
  } catch (e) {
    showAlert('red', '❌ Could not protect your PIN. Try again over HTTPS.');
    return;
  }
  // Separate copy of the wallet secret, encrypted with the SMS PIN instead of
  // the account password, so the SMS relay server can unlock it once it has
  // verified the PIN texted in by the user — without ever knowing the password.
  var pinWalletSecretRecord;
  try {
    pinWalletSecretRecord = await encryptWalletSecret(secKey, pin);
  } catch (e) {
    showAlert('red', '❌ Could not protect your wallet for SMS payments. Try again over HTTPS.');
    return;
  }
  var contract = generateContractAddress();
  var country  = (document.getElementById('regCountry') || {}).value || '\U0001f1f5\U0001f1ed Philippines';
  var now = new Date();
  var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var memberSince = monthNames[now.getMonth()] + ' ' + now.getFullYear();

  PENDING_USER = {
    uid:             user.toLowerCase(),
    username:        user,
    email:           email,
    name:            fullName,
    nameLower:       fullName.toLowerCase(),
    phone:           phone,
    type:            type,
    country:         country,
    walletPublic:    pubKey,
    _unlockedWalletSecret: secKey,
    walletSecretEncrypted: walletSecretRecord.ciphertext,
    walletSecretSalt: walletSecretRecord.salt,
    walletSecretIv:   walletSecretRecord.iv,
    smsPinHash:      pinRecord.hash,
    smsPinSalt:      pinRecord.salt,
    pinWalletSecretEncrypted: pinWalletSecretRecord.ciphertext,
    pinWalletSecretSalt:      pinWalletSecretRecord.salt,
    pinWalletSecretIv:        pinWalletSecretRecord.iv,
    contractAddress: contract,
    xlmBalance:      10000,
    balance:         2500,
    dailyLimit:      100000,
    cardFrozen:      false,
    vaultLocked:     0,
    trustScore:      5,
    goodTxCount:     0,
    monoCounter:     0,
    memberSince:     memberSince,
    _password:       pass
  };

  goTo('wallet-setup');
  runWalletSetup(pubKey);
}

function runWalletSetup(pubKey) {
  var steps = [
    { id: 'wsStep1', statusId: 'wsS1', delay: 800  },
    { id: 'wsStep2', statusId: 'wsS2', delay: 1600 },
    { id: 'wsStep3', statusId: 'wsS3', delay: 2600 },
    { id: 'wsStep4', statusId: 'wsS4', delay: 3400 }
  ];

  steps.forEach(function(s){ document.getElementById(s.statusId).textContent = '⏸️'; });

  var _friendbotDone = false;
  var _friendbotXLM  = 10000;
  var _friendbotError = null;
  var _friendbotRequest = fetch('https://friendbot.stellar.org/?addr=' + encodeURIComponent(pubKey))
    .then(function(r) {
      if (!r.ok) throw new Error('Friendbot returned HTTP ' + r.status);
      return r.json();
    })
    .then(function(){ _friendbotDone = true; })
    .catch(function(error){ _friendbotError = error; _friendbotDone = true; });

  function activateStep(idx) {
    if (idx >= steps.length) {
      _friendbotRequest.then(function(){
        if (_friendbotError) {
          var errorText = 'Testnet funding failed. Open Friendbot and fund this wallet before sending XLM.';
          document.getElementById('wsErrorBox').style.display = 'block';
          document.getElementById('wsErrorMsg').textContent = errorText;
          document.getElementById('wsErrorCode').textContent = _friendbotError.message || '';
          document.querySelector('#wallet-setup .ws-sub').textContent = 'Wallet created, but Testnet funding is still required.';
          return;
        }
        setTimeout(function(){
        document.getElementById('wsPublicKey').textContent  = pubKey;
        document.getElementById('wsXLMBal').textContent    = '10,000.0000 XLM';
        if (PENDING_USER) { PENDING_USER.xlmBalance = _friendbotXLM; }
        var _cfg = _getCountryConfig(PENDING_USER && PENDING_USER.country);
        document.getElementById('wsPHPBal').textContent    = '~ ' + _cfg.sym + '...' + ' ' + _cfg.coin + ' (loading)';
        document.getElementById('wsPHPBal').nextElementSibling && (document.getElementById('wsPHPBal').nextElementSibling.textContent = 'Local Currency Equivalent');
        document.getElementById('wsWalletCard').classList.add('show');
        document.getElementById('wsContinueBtn').classList.add('show');
        document.querySelector('#wallet-setup .ws-sub').textContent = 'Your Stellar Testnet wallet is ready! 🎉';
        }, 400);
      });
      return;
    }
    var step    = steps[idx];
    var stepEl  = document.getElementById(step.id);
    var statusEl= document.getElementById(step.statusId);
    stepEl.classList.add('active');
    statusEl.innerHTML = '<div class="ws-spinner"></div>';
    setTimeout(function(){
      stepEl.classList.remove('active');
      stepEl.classList.add('done');
      statusEl.textContent = '✅';
      activateStep(idx + 1);
    }, step.delay - (idx > 0 ? steps[idx-1].delay : 0));
  }

  setTimeout(function(){ activateStep(0); }, 400);
}

async function finishWalletSetup() {
  if (!PENDING_USER) { goTo('login'); return; }

  showLoading(true, 'Creating your account…');

  var authUser = null;
  try {
    var credential = await auth.createUserWithEmailAndPassword(
      PENDING_USER.email,
      PENDING_USER._password
    );
    authUser = credential.user;
    await authUser.updateProfile({ displayName: PENDING_USER.name });
  } catch (authError) {
    showLoading(false);
    var authCode = authError && authError.code ? authError.code : '';
    console.warn('OmniPay sign-up error:', authError);
    var authMessages = {
      'auth/email-already-in-use': '❌ An account already exists for this email address.',
      'auth/invalid-email': '❌ That email address is not valid.',
      'auth/weak-password': '❌ Password is too weak. Use at least 6 characters with a number.',
      'auth/operation-not-allowed': '❌ Email/Password sign-in is turned off. Enable it in Firebase Console → Authentication → Sign-in method.',
      'auth/admin-restricted-operation': '❌ Sign-ups are disabled for this project. Enable user sign-up in Firebase Console → Authentication → Settings.',
      'auth/network-request-failed': '❌ Network error. Check your connection and try again.',
      'auth/too-many-requests': '❌ Too many attempts. Please wait a moment and try again.',
      'auth/unauthorized-domain': '❌ This domain is not authorized. Add it in Firebase Console → Authentication → Settings → Authorized domains.',
      'auth/invalid-api-key': '❌ The Firebase API key is invalid. Check firebaseConfig.',
      'auth/api-key-not-valid.-please-pass-a-valid-api-key.': '❌ The Firebase API key is invalid. Check firebaseConfig.',
      'auth/requests-from-referer-blocked': '❌ This site is blocked by the API key restrictions. Allow this domain in Google Cloud Console → Credentials.'
    };
    var authMessage = authMessages[authCode]
      || ('❌ Could not create the account' + (authCode ? ' (' + authCode + ')' : '') + '. Check the email and try again.');
    showAlert('red', authMessage);
    return;
  }

  var profileData = {
    uid:             authUser.uid,
    username:        PENDING_USER.username,
    email:           PENDING_USER.email,
    name:            PENDING_USER.name,
    nameLower:       PENDING_USER.nameLower,
    phone:           PENDING_USER.phone,
    type:            PENDING_USER.type,
    country:         PENDING_USER.country || '\U0001f1f5\U0001f1ed Philippines',
    walletPublic:    PENDING_USER.walletPublic,
    walletSecretEncrypted: PENDING_USER.walletSecretEncrypted,
    walletSecretSalt: PENDING_USER.walletSecretSalt,
    walletSecretIv:   PENDING_USER.walletSecretIv,
    smsPinHash:      PENDING_USER.smsPinHash,
    smsPinSalt:      PENDING_USER.smsPinSalt,
    pinWalletSecretEncrypted: PENDING_USER.pinWalletSecretEncrypted,
    pinWalletSecretSalt:      PENDING_USER.pinWalletSecretSalt,
    pinWalletSecretIv:        PENDING_USER.pinWalletSecretIv,
    contractAddress: PENDING_USER.contractAddress,
    xlmBalance:      PENDING_USER.xlmBalance,
    balance:         PENDING_USER.balance,
    dailyLimit:      PENDING_USER.dailyLimit,
    cardFrozen:      PENDING_USER.cardFrozen,
    vaultLocked:     PENDING_USER.vaultLocked,
    trustScore:      PENDING_USER.trustScore,
    goodTxCount:     PENDING_USER.goodTxCount,
    monoCounter:     PENDING_USER.monoCounter,
    memberSince:     PENDING_USER.memberSince
  };

  var saved = await saveUserProfile(authUser.uid, profileData);

  if (saved) {
    try {
      await db.collection(USERNAME_LOOKUP_COLLECTION).doc(PENDING_USER.username.toLowerCase()).set({
        uid: authUser.uid,
        email: PENDING_USER.email
      });
    } catch (e) { console.warn('Username lookup save error:', e); }
  }

  if (!saved) {
    try { await authUser.delete(); } catch (_) {}
    showLoading(false);
    var fbErr  = LAST_FIRESTORE_ERROR || {};
    var errMsg = '❌ Could not create your account.';
    if (fbErr.code === 'permission-denied') {
      errMsg = '❌ Firestore blocked the write (permission-denied). Update your Firestore Security Rules to allow writes.';
    } else if (fbErr.message) {
      errMsg = '❌ ' + fbErr.message;
    } else {
      errMsg = '❌ Could not create your account. Check your connection and try again.';
    }
    showAlert('red', errMsg);
    showFirebaseError(errMsg, fbErr.code || 'firestore/write-failed');
    return;
  }

  showLoading(false);

  STATE.isLoggedIn = true;
  STATE.uid  = authUser.uid;
  STATE.user = {
    username: PENDING_USER.username,
    name:     PENDING_USER.name,
    phone:    PENDING_USER.phone,
    email:    PENDING_USER.email,
    type:     PENDING_USER.type,
    country:  PENDING_USER.country || '\U0001f1f5\U0001f1ed Philippines'
  };
  STATE.balance     = PENDING_USER.balance;
  STATE.vaultLocked = 0;
  STATE.trustScore  = 5;
  STATE.wallet = {
    publicKey:       PENDING_USER.walletPublic,
    secretKey:       PENDING_USER._unlockedWalletSecret || '',
    xlmBalance:      PENDING_USER.xlmBalance,
    contractAddress: PENDING_USER.contractAddress
  };
  STATE.memberSince        = PENDING_USER.memberSince;
  STATE.vaultUsesTotal     = 1;
  STATE.vaultUsesRemaining = 1;
  STATE.transactions       = [];
  STATE.fraudAlerts        = [];
  STATE.pendingTxCount     = 0;
  STATE.goodTxCount        = 0;
  STATE.monoCounter        = 0;
  STATE.noncePool          = [1,2,3,4,5,6,7,8,9,10];
  STATE.usedNonces         = [];
  STATE.wallets = [{
    publicKey: PENDING_USER.walletPublic,
    label: 'Primary Wallet',
    xlmBalance: PENDING_USER.xlmBalance || 10000,
    addedAt: Date.now()
  }];
  STATE.activeWalletIndex = 0;

  STATE.transactions.push({
    id: 'tx-welcome', type: 'receive', name: 'OmniPay Welcome Bonus',
    amount: 2500, status: 'synced', mode: 'online',
    note: 'Testnet starter balance', ts: Date.now(), icon: '🎁'
  });

  var pendingCopy = PENDING_USER;
  delete pendingCopy._password;
  PENDING_USER = null;

  ['regFirst','regLast','regUser','regPhone','regEmail','regPass','regPin'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var terms = document.getElementById('regTerms');
  if (terms) terms.checked = false;

  document.getElementById('bottomNav').style.display = 'flex';
  navTo('home');
  saveSession();
  showAlert('success','🎉 Wallet ready! 10,000 XLM funded by Friendbot on Testnet!');
  startInboxListener(); // begin real-time incoming-payment listener

  setTimeout(function(){
    document.getElementById('wsWalletCard').classList.remove('show');
    document.getElementById('wsContinueBtn').classList.remove('show');
    document.querySelector('#wallet-setup .ws-sub').textContent = 'Creating your Freighter wallet\non Stellar Testnet…';
    ['wsStep1','wsStep2','wsStep3','wsStep4'].forEach(function(id){
      document.getElementById(id).classList.remove('active','done');
    });
    ['wsS1','wsS2','wsS3','wsS4'].forEach(function(id,i){
      document.getElementById(id).textContent = i===0?'⏳':'⏸️';
    });
  }, 500);
}

async function fetchLiveXLMBalance() {
  if (!STATE.wallet || !STATE.wallet.publicKey) return;
  var pubKey = STATE.wallet.publicKey;
  try {
    var resp = await fetch('https://horizon-testnet.stellar.org/accounts/' + pubKey);
    if (resp.status === 404) {
      return;
    }
    if (!resp.ok) return;
    var data = await resp.json();
    var native = (data.balances || []).find(function(b){ return b.asset_type === 'native'; });
    if (!native) return;
    var live = parseFloat(native.balance);
    if (isNaN(live)) return;

    if (Date.now() < (STATE._balanceGraceUntil || 0) && live > STATE.wallet.xlmBalance) {
      return;
    }

    STATE.wallet.xlmBalance = live;
    if (STATE.wallets && typeof STATE.activeWalletIndex === 'number' && STATE.wallets[STATE.activeWalletIndex]) {
      STATE.wallets[STATE.activeWalletIndex].xlmBalance = live;
    }
    syncSpendableBalance();

    var heroEl = document.getElementById('heroBalance');
    if (heroEl) heroEl.textContent = live.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4});

    var profEl = document.getElementById('profileXLM');
    if (profEl) profEl.textContent = live.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4}) + ' XLM';

    var lblEls = document.querySelectorAll('.freighter-xlm-lbl');
    lblEls.forEach(function(el){
      if (el.textContent.indexOf('Friendbot') !== -1 || el.textContent.indexOf('live') !== -1) {
        el.textContent = 'Live balance · Stellar Testnet ✅';
      }
    });

    _updateXLMConversion(live);

    var stelBal = document.getElementById('stellarXLMBal');
    if (stelBal) stelBal.textContent = live.toLocaleString('en',{minimumFractionDigits:4}) + ' XLM';

  } catch(_e) {  }
}

var _selectedBiller = '';

function showPayBillsModal() {
  if (!STATE.isLoggedIn) { showAlert('orange','⚠️ Please log in first'); return; }
  _selectedBiller = '';
  var form = document.getElementById('billPayForm');
  if (form) form.style.display = 'none';
  var acct = document.getElementById('billAcctNo'); if (acct) acct.value = '';
  var amt  = document.getElementById('billAmount'); if (amt)  amt.value  = '';
  var avail = document.getElementById('billAvailBal');
  if (avail) avail.textContent = (STATE.wallet ? STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4}) : '0') + ' XLM';
  showModal('payBillsModal');
}

function selectBiller(name, category) {
  _selectedBiller = name;
  var billerEl = document.getElementById('billPayBiller');
  if (billerEl) billerEl.textContent = name + ' (' + category + ')';
  var avail = document.getElementById('billAvailBal');
  if (avail) avail.textContent = (STATE.wallet ? STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4}) : '0') + ' XLM';
  var form = document.getElementById('billPayForm');
  if (form) { form.style.display = 'block'; form.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
}

async function doPayBill() {
  if (!_selectedBiller) { showAlert('orange','⚠️ Select a biller first'); return; }
  var acctEl = document.getElementById('billAcctNo');
  var amtEl  = document.getElementById('billAmount');
  var acct = acctEl ? acctEl.value.trim() : '';
  var amt  = parseFloat(amtEl ? amtEl.value : '0');
  if (!acct) { if (acctEl) acctEl.classList.add('error'); showAlert('red','⚠️ Enter account / reference number'); return; }
  if (!isFinite(amt) || amt <= 0) { if (amtEl) amtEl.classList.add('error'); showAlert('red','⚠️ Enter a valid amount'); return; }
  if (STATE.wallet && amt > STATE.wallet.xlmBalance) {
    if (amtEl) amtEl.classList.add('error');
    showAlert('red','❌ Insufficient XLM balance'); return;
  }

  showLoading(true,'Processing bill payment…');
  await new Promise(function(r){ setTimeout(r, 1400); }); // simulate processing
  showLoading(false);

  if (STATE.wallet) { STATE.wallet.xlmBalance = Math.max(0, STATE.wallet.xlmBalance - amt); }

  STATE.transactions.unshift({
    id: 'bill-' + Date.now(), type:'send', name:'Pay Bills · ' + _selectedBiller,
    amount: amt * 50, status:'synced', mode:'online',
    note: 'Account: ' + acct + ' · ' + amt + ' XLM', ts: Date.now(), icon:'🧾'
  });

  closeModal('payBillsModal');
  showAlert('success','✅ Bill paid! ' + amt + ' XLM sent to ' + _selectedBiller);

  if (STATE.wallet) {
    var heroEl = document.getElementById('heroBalance');
    if (heroEl) heroEl.textContent = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4});
    _updateXLMConversion(STATE.wallet.xlmBalance);
  }
  setTimeout(fetchLiveXLMBalance, 2500);
}

function copyInternalWalletAddress() {
  var addr = (STATE.wallet && STATE.wallet.publicKey) || '';
  if (!addr) { showAlert('orange','⚠️ No wallet address found'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(addr).then(function(){
      showAlert('success','📋 Wallet address copied!');
    }).catch(function(){ _copyFallback(addr); });
  } else { _copyFallback(addr); }
  function _copyFallback(a) {
    var ta = document.createElement('textarea');
    ta.value = a; ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); showAlert('success','📋 Copied!'); } catch(e) { showAlert('orange','Copy manually: ' + a); }
    document.body.removeChild(ta);
  }
}

function doLogout() {
  stopInboxListener(); // tear down real-time listener before clearing state
  if (auth) auth.signOut().catch(function(){});
  STATE.isLoggedIn = false;
  STATE.uid        = null;
  try { sessionStorage.removeItem('omnipay_session'); } catch(e) {}
  document.getElementById('bottomNav').style.display = 'none';
  goTo('login');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  setFbStatus('', 'Connecting to Firebase…');
  showAlert('yellow','👋 Signed out successfully');
}

function togglePass(id, btn) {
  var inp = document.getElementById(id);
  if (inp.type === 'password') { inp.type = 'text';     btn.textContent = '🙈'; }
  else                         { inp.type = 'password'; btn.textContent = '👁'; }
}

function fmtAmt(n) {
  return '₱' + (n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtTxAmt(tx) {
  if (tx.txHash) {
    return (tx.amount||0).toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4}) + ' XLM';
  }
  return fmtAmt(tx.amount);
}
function fmtTime(ts) {
  var d = new Date(ts);
  var now = new Date();
  var diff = now - d;
  if (diff < 60000)    return Math.max(0, Math.floor(diff/1000))+'s ago';
  if (diff < 3600000)  return Math.floor(diff/60000)+'m ago';
  if (diff < 86400000) return Math.floor(diff/3600000)+'h ago';
  return d.toLocaleDateString('en-PH',{month:'short',day:'numeric'});
}

function syncSpendableBalance() {
  if (!STATE.wallet) return;
  var total = STATE.wallet.xlmBalance || 0;
  STATE.balance = Math.max(0, total - (STATE.vaultLocked || 0));
  var sendBal = document.getElementById('sendBal');
  if (sendBal) sendBal.textContent = STATE.balance.toFixed(6) + ' XLM';
}

function transactionKey(tx) {
  if (!tx || typeof tx !== 'object') return '';
  if (tx.txHash) return 'hash:' + String(tx.txHash);
  if (tx.id) return 'id:' + String(tx.id);
  return '';
}

function dedupeTransactions(list) {
  var result = [];
  var indexByKey = Object.create(null);

  (Array.isArray(list) ? list : []).forEach(function(tx) {
    if (!tx || typeof tx !== 'object') return;

    var key = transactionKey(tx);
    if (!key) {
      result.push(tx);
      return;
    }

    if (indexByKey[key] == null) {
      indexByKey[key] = result.length;
      result.push(tx);
      return;
    }

    var existingIndex = indexByKey[key];
    var existing = result[existingIndex];
    if ((!existing.txHash && tx.txHash) || (!existing.note && tx.note)) {
      result[existingIndex] = Object.assign({}, existing, tx);
    }
  });

  result.sort(function(a, b) {
    return (b.ts || 0) - (a.ts || 0);
  });
  return result;
}

function normalizeTransactionState() {
  STATE.transactions = dedupeTransactions(STATE.transactions);
  return STATE.transactions;
}

function renderHome() {
  normalizeTransactionState();
  syncSpendableBalance();
  var t = getTrustTier(STATE.trustScore);
  var firstName = STATE.user.name ? STATE.user.name.split(' ')[0] : 'User';
  document.getElementById('heroName').textContent = firstName + ' 👋';
  var _xlmBal = STATE.wallet ? (STATE.wallet.xlmBalance || 0) : 0;
  document.getElementById('heroBalance').textContent = _xlmBal.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4});
  _updateXLMConversion(_xlmBal);
  fetchLiveXLMBalance();
  var vaultMax = Math.floor(STATE.balance * t.pct / 100);
  document.getElementById('heroVault').textContent   = t.icon+' '+t.tier;
  document.getElementById('heroTrust').textContent   = STATE.trustScore;
  document.getElementById('heroPending').textContent = STATE.isOnline ? 'Online' : 'Offline';

  document.getElementById('trustScoreVal').textContent        = STATE.trustScore;
  document.getElementById('trustFill').style.width            = STATE.trustScore+'%';
  document.getElementById('trustTierBadge').textContent       = t.icon+' '+t.tier;
  document.getElementById('trustTierBadge').style.background  = t.bg;
  document.getElementById('trustTierBadge').style.color       = t.color;
  document.getElementById('trustPct').textContent             = t.pct+'%';
  document.getElementById('tsOffLimit').textContent           = fmtAmt(vaultMax);
  document.getElementById('tsMaxUse').textContent             = t.uses===99?'∞':t.uses+'×';
  document.getElementById('tsGoodTx').textContent             = STATE.goodTxCount;
  document.getElementById('tsLastSync').textContent           = '2h ago';

  var homeCardStatus = document.getElementById('homeOmniCardStatus');
  if (homeCardStatus) {
    homeCardStatus.textContent = getOmniCardState().label;
  }

  var container = document.getElementById('recentTxList');
  var recent = STATE.transactions.slice(0,4);
  if (recent.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:28px 0;"><div class="empty-icon">💳</div><h4>No transactions yet</h4><p>Send or receive money to get started</p></div>';
  } else {
    container.innerHTML = recent.map(function(tx){ return renderTxItem(tx); }).join('');
  }

  var alertSec = document.getElementById('alertSection');
  if (STATE.fraudAlerts.length > 0) {
    alertSec.innerHTML = '<div class="section-title">⚠️ Active Alerts</div>' +
      STATE.fraudAlerts.map(function(a){
        return '<div class="card" style="background:'+(a.type==='RED'?'#FFF0F3':a.type==='ORANGE'?'#FFF5E0':'#FFFCE0')+'; border-left:3px solid '+(a.type==='RED'?'var(--danger)':a.type==='ORANGE'?'var(--warning)':'#F0C000')+'; margin-bottom:10px;"><div style="font-size:13px; font-weight:700; color:var(--text);">'+(a.type==='RED'?'🔴':a.type==='ORANGE'?'🟠':'🟡')+' '+safeText(a.pattern)+'</div><div style="font-size:12px; color:var(--text-muted); margin-top:4px; font-weight:500;">'+safeText(a.msg)+'</div><div style="font-size:11px; color:var(--text-muted); margin-top:6px;">'+fmtTime(a.ts)+'</div></div>';
      }).join('');
  } else {
    alertSec.innerHTML = '';
  }

  var sendBal = document.getElementById('sendBal');
  if (sendBal) sendBal.textContent = (STATE.balance||0).toFixed(6)+' XLM';
}

function renderTxItem(tx) {
  var isCredit  = tx.type === 'receive';
  var iconBg    = isCredit ? 'rgba(46,213,115,0.1)' : tx.status==='failed' ? 'rgba(255,71,87,0.1)' : tx.mode==='offline' ? 'rgba(47,111,237,0.1)' : 'rgba(255,165,2,0.1)';
  var statusText= tx.status==='synced'?'✅ Synced':tx.status==='pending'?'⏳ Pending Sync':tx.status==='offline'?'📴 Offline':'❌ Failed';
  var hashLine = '';
  if (tx.txHash) {
    var shortHash = tx.txHash.substring(0,10) + '…' + tx.txHash.slice(-6);
    hashLine = '<div style="margin-top:5px;background:var(--primary-light);border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'
      + '<span style="font-family:\'Courier New\',monospace;font-size:10px;color:var(--primary);font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+safeText(tx.txHash)+'">TX: '+safeText(shortHash)+'</span>'
      + '<button class="tx-copy" data-tx-hash="'+safeText(tx.txHash)+'" onclick="copyTxHash(this.dataset.txHash)" style="flex-shrink:0;font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid var(--primary);background:#fff;color:var(--primary);font-weight:700;cursor:pointer;">📋 Copy</button>'
      + '<a href="https://stellar.expert/explorer/testnet/tx/'+encodeURIComponent(String(tx.txHash))+'" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;font-size:10px;color:var(--primary);font-weight:600;text-decoration:none;white-space:nowrap;">⭐ Explorer ›</a>'
      + '</div>';
  }
  return '<div class="tx-item"><div class="tx-icon" style="background:'+iconBg+';">'+safeText(tx.icon)+'</div><div class="tx-info tx-content"><div class="tx-name">'+safeText(tx.name)+'</div><div class="tx-sub">'+safeText(tx.note)+' · '+fmtTime(tx.ts)+'</div><span class="tx-status '+safeText(tx.status)+'">'+statusText+'</span>'+hashLine+'</div><div class="tx-amount-wrap"><div class="tx-amount '+(isCredit?'credit':'debit')+'">'+(isCredit?'+':'-')+fmtTxAmt(tx)+'</div></div></div>';
}

function copyTxHash(hash) {
  var text = String(hash || '');
  if (!/^[A-Za-z0-9]+$/.test(text)) {
    showAlert('red', '❌ Invalid transaction hash');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){
      showAlert('success', '📋 TX hash copied!');
    }).catch(function(){ showAlert('yellow', '📋 Copy the hash manually'); });
  }
}

function renderVault() {
  normalizeTransactionState();
  syncSpendableBalance();
  var t = getTrustTier(STATE.trustScore);
  var vaultMax = Math.floor(STATE.balance * t.pct / 100);
  document.getElementById('vaultBig').textContent     = fmtAmt(STATE.vaultLocked);
  document.getElementById('vaultPctInfo').textContent = t.pct+'% of '+fmtAmt(STATE.balance)+' locked · Trust '+t.tier+' tier';
  document.getElementById('maxExposure').textContent  = fmtAmt(vaultMax);

  var row = document.getElementById('vaultUsesRow');
  var chips = '';
  var usesTotal = t.uses === 99 ? 10 : t.uses;
  for (var i = 0; i < usesTotal; i++) {
    var used = i >= STATE.vaultUsesRemaining;
    chips += '<div class="vault-use-chip '+(used?'used':'')+'">'+( used?'✗':'✓')+' Use '+(i+1)+'</div>';
  }
  if (t.uses === 99) chips += '<div class="vault-use-chip">∞ Unlimited</div>';
  row.innerHTML = chips;

  var limits = [
    { range:'0–25',  pct:'30%', uses:'1×',        ex: fmtAmt(STATE.balance*0.3),  tier:'New',      icon:'⚪' },
    { range:'26–50', pct:'50%', uses:'2×',        ex: fmtAmt(STATE.balance*0.5),  tier:'Building', icon:'🟡' },
    { range:'51–75', pct:'65%', uses:'4×',        ex: fmtAmt(STATE.balance*0.65), tier:'Trusted',  icon:'🟠' },
    { range:'76–100',pct:'80%', uses:'Unlimited', ex: fmtAmt(STATE.balance*0.8),  tier:'VIP',      icon:'🟢' }
  ];
  var currentTierIdx = STATE.trustScore<=25?0:STATE.trustScore<=50?1:STATE.trustScore<=75?2:3;
  document.getElementById('trustLimitsCard').innerHTML = limits.map(function(l,i){
    return '<div class="info-row" style="'+(i===currentTierIdx?'background:var(--primary-light); margin:0 -18px; padding:12px 18px; border-radius:10px;':'')+'"><span class="info-label">'+l.icon+' '+l.range+' ('+l.tier+')</span><div style="text-align:right;"><div class="info-val">'+l.pct+' · '+l.uses+'</div><div style="font-size:11px; color:var(--text-muted); font-weight:500;">'+l.ex+' max</div></div></div>';
  }).join('');

  var pending = STATE.transactions.filter(function(tx){ return tx.status === 'pending'; });
  var pdiv = document.getElementById('pendingTxList');
  if (pending.length === 0) {
    pdiv.innerHTML = '<div class="empty-state" style="padding:24px;"><div class="empty-icon">✅</div><h4>All Synced</h4><p>No pending offline transactions</p></div>';
  } else {
    pdiv.innerHTML = '<div class="card" style="padding:8px 16px;">'+pending.map(function(tx){ return renderTxItem(tx); }).join('')+'</div>';
  }

  renderNonces();
  updateOfflinePayUI();
}

function renderNonces() {
  var el = document.getElementById('nonceList');
  if (!el) return;
  el.innerHTML = STATE.noncePool.map(function(n){
    return '<div class="nonce-chip '+(STATE.usedNonces.indexOf(n) !== -1 ?'used':'')+'">#'+String(n).padStart(3,'0')+'</div>';
  }).join('');
}

function updateOfflinePayUI() {
  var el1 = document.getElementById('offlineVaultAmt');
  var el2 = document.getElementById('offlineUsesLeft');
  var el3 = document.getElementById('offlineVaultBar');
  if (el1) el1.textContent = fmtAmt(STATE.vaultLocked);
  if (el2) el2.textContent = (STATE.vaultUsesRemaining===99?'∞':STATE.vaultUsesRemaining)+' uses left';
  if (el3) { var pct = STATE.balance > 0 ? (STATE.vaultLocked / STATE.balance)*100 : 0; el3.style.width=pct+'%'; }
}

function renderHistory(filter) {
  var allTxs = normalizeTransactionState();
  var txs = filter === 'all' ? allTxs : allTxs.filter(function(tx){
    return tx.status === filter || (filter === 'offline' && tx.mode === 'offline');
  });
  var el = document.getElementById('fullTxList');
  if (txs.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><h4>No transactions</h4><p>No '+filter+' transactions found</p></div>';
  } else {
    el.innerHTML = txs.map(function(tx){ return renderTxItem(tx); }).join('');
  }

}

function filterTx(filter, el) {
  document.querySelectorAll('.filter-chip').forEach(function(c){ c.classList.remove('active'); });
  el.classList.add('active');
  renderHistory(filter);
}

function renderProfile() {
  normalizeTransactionState();
  syncSpendableBalance();
  var t = getTrustTier(STATE.trustScore);
  document.getElementById('profileName').textContent        = STATE.user.name || 'User';
  document.getElementById('profilePhone').textContent       = STATE.user.phone || '—';
  document.getElementById('profileTrustScore').textContent  = STATE.trustScore;
  document.getElementById('profileTrustFill').style.width   = STATE.trustScore+'%';
  document.getElementById('profileTrustFill').style.background = 'linear-gradient(90deg,'+t.color+',rgba(255,255,255,0.5))';
  document.getElementById('profileTrustTier').textContent   = t.icon+' '+t.tier;
  document.getElementById('profileTrustTier').style.background= t.bg;
  document.getElementById('profileTrustTier').style.color   = t.color;

  var beltMap  = { New:'New Member', Building:'Bronze Belt', Trusted:'Orange Belt', VIP:'Gold Belt' };
  var levelMap = { New:'Level 1', Building:'Level 2', Trusted:'Level 3', VIP:'Level 4' };
  var typeMap  = { personal:'Personal', merchant:'Merchant Partner', enterprise:'Enterprise' };
  document.getElementById('profileBelt').textContent  = beltMap[t.tier]  || 'Orange Belt';
  document.getElementById('profileLevel').textContent = levelMap[t.tier] || 'Level 3';
  document.getElementById('profileType').textContent  = typeMap[STATE.user.type] || STATE.user.type;

  document.getElementById('profileXLM').textContent       = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4})+' XLM';
  document.getElementById('profileWalletKey').textContent = STATE.wallet.publicKey || 'Generating…';

  var activeLabel = document.getElementById('activeWalletLabel');
  if (activeLabel) {
    var wallets = STATE.wallets || [];
    var idx     = STATE.activeWalletIndex || 0;
    var wLabel  = (wallets[idx] && wallets[idx].label) ? wallets[idx].label : 'Primary Wallet';
    var wCount  = wallets.length;
    activeLabel.textContent = '💼 Active: ' + wLabel + (wCount > 1 ? ' (' + (idx + 1) + ' of ' + wCount + ')' : '');
  }

  fetchLiveXLMBalance();

  var recvKey = document.getElementById('receiveWalletKey');
  if (recvKey) recvKey.textContent = STATE.wallet.publicKey || '—';
  var recvTrust = document.getElementById('receiveTrustScore');
  if (recvTrust) recvTrust.textContent = STATE.trustScore+'/100';

  var totalTx = STATE.transactions.length;
  var synced  = STATE.transactions.filter(function(tx){ return tx.status==='synced'; }).length;
  var pending = STATE.transactions.filter(function(tx){ return tx.status==='pending'; }).length;
  document.getElementById('accountSummary').innerHTML =
    '<div class="info-row"><span class="info-label">Full Name</span><span class="info-val">'+safeText(STATE.user.name||'—')+'</span></div>'+
    '<div class="info-row"><span class="info-label">Username</span><span class="info-val">@'+safeText(STATE.user.username||'—')+'</span></div>'+
    '<div class="info-row"><span class="info-label">Email</span><span class="info-val" style="font-size:12px;">'+safeText(STATE.user.email||'—')+'</span></div>'+
    '<div class="info-row"><span class="info-label">Phone</span><span class="info-val">'+safeText(STATE.user.phone||'—')+'</span></div>'+
    '<div class="info-row"><span class="info-label">Total Transactions</span><span class="info-val">'+totalTx+'</span></div>'+
    '<div class="info-row"><span class="info-label">Synced</span><span class="info-val" style="color:var(--success);">'+synced+'</span></div>'+
    '<div class="info-row"><span class="info-label">Pending Sync</span><span class="info-val" style="color:var(--warning);">'+pending+'</span></div>'+
    '<div class="info-row"><span class="info-label">Total Balance</span><span class="info-val">'+fmtAmt(STATE.balance)+'</span></div>'+
    '<div class="info-row"><span class="info-label">Offline Vault</span><span class="info-val">'+fmtAmt(STATE.vaultLocked)+'</span></div>'+
    '<div class="info-row"><span class="info-label">XLM Balance</span><span class="info-val">'+STATE.wallet.xlmBalance.toLocaleString('en')+'</span></div>'+
    '<div class="info-row"><span class="info-label">Account Type</span><span class="info-val" style="text-transform:capitalize;">'+safeText(STATE.user.type||'personal')+'</span></div>'+
    '<div class="info-row"><span class="info-label">Member Since</span><span class="info-val">'+safeText(STATE.memberSince||'—')+'</span></div>';
}

function simulateScan() {
  showAlert('success','📷 QR Scanned! Merchant: Aling Nena Store');
  setTimeout(function(){ showManualPayModal(); }, 800);
}

function showManualPayModal() {
  document.getElementById('manualCode').value   = 'OMNI-ALNG-NNA1';
  document.getElementById('manualAmount').value = '';
  showModal('manualPayModal');
}

function processManualPay() {
  var amt = parseFloat(document.getElementById('manualAmount').value);
  if (!isFinite(amt) || amt <= 0) { showAlert('red','⚠️ Enter a valid amount'); return; }
  closeModal('manualPayModal');
  doPaymentSuccess(amt, 'Aling Nena Store', STATE.isOnline ? 'online' : 'offline');
}

async function doSendMoney() {
  syncSpendableBalance();
  var recipientEl = document.getElementById('sendRecipient');
  var recipient = normalizeStellarPublicKey(recipientEl ? recipientEl.value : '');
  var amt       = parseFloat(document.getElementById('sendAmount').value);
  var note      = (document.getElementById('sendNote') || {}).value || 'Online payment';

  if (!recipient)          { showAlert('red','⚠️ Enter a Stellar recipient address (G…)'); return; }
  if (!isFinite(amt) || amt <= 0)    { showAlert('red','⚠️ Enter a valid amount'); return; }
  if (amt > STATE.balance) { showAlert('red','❌ Insufficient balance'); return; }

  if (recipientEl) recipientEl.value = recipient;
  if (!isValidStellarPublicKey(recipient)) {
    if (recipientEl) recipientEl.classList.add('error');
    showAlert('red','❌ ' + stellarAddressError(recipient));
    return;
  }

  var secretKey    = STATE.wallet.secretKey;   // always Primary's key
  var primaryPublic = secretKey
    ? (function(){ try { return StellarSdk.Keypair.fromSecret(secretKey).publicKey(); } catch(e){ return null; } })()
    : null;
  var activePublic = STATE.wallet.publicKey;   // may be a watch-only wallet

  var isWatchOnly = activePublic && primaryPublic && (activePublic !== primaryPublic);

  var freighterForActive = (
    typeof FREIGHTER !== 'undefined' &&
    FREIGHTER.isConnected &&
    FREIGHTER.publicKey &&
    FREIGHTER.publicKey === activePublic &&
    typeof getFreighterAPI === 'function' &&
    getFreighterAPI()
  );

  var useFreighter = freighterForActive;

  if (isWatchOnly && !useFreighter) {
    var activeLabel = (STATE.wallets && STATE.wallets[STATE.activeWalletIndex] && STATE.wallets[STATE.activeWalletIndex].label) || 'this wallet';
    var shortAddr   = activePublic.substring(0,6) + '…' + activePublic.slice(-4);
    showAlert('red',
      '❌ "' + activeLabel + '" (' + shortAddr + ') is a watch-only wallet. ' +
      'Open Freighter, switch to that address, then try again.'
    );
    return;
  }

  if (!useFreighter && !secretKey) {
    showAlert('red','❌ No signing method available. Re-login or connect Freighter.');
    return;
  }

  var sourcePublic = useFreighter ? FREIGHTER.publicKey : primaryPublic;
  if (!sourcePublic || !isValidStellarPublicKey(sourcePublic)) {
    showAlert('red', '❌ This account has an invalid Stellar signing key. Create a new Testnet wallet and try again.');
    return;
  }

  var btn = document.querySelector('[onclick="doSendMoney()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Sending…'; }
  showLoading(true, useFreighter ? 'Waiting for Freighter approval…' : 'Submitting to Stellar testnet…');

  try {
    var amtStr = amt.toFixed(7);

    var destinationExists = await stellarAccountExists(recipient);
    if (!destinationExists) {
      throw new Error('Recipient wallet is not activated on Stellar Testnet. Ask the recipient to fund or activate the account first.');
    }

    var accountResp = await fetch(STELLAR_HORIZON_TESTNET + '/accounts/' + encodeURIComponent(sourcePublic));
    if (accountResp.status === 404 && !useFreighter) {
      showLoading(true, 'Funding your Testnet wallet…');
      await fundTestnetAccount(sourcePublic);
      accountResp = await fetch(STELLAR_HORIZON_TESTNET + '/accounts/' + encodeURIComponent(sourcePublic));
    }
    if (!accountResp.ok) {
      var errBody = await accountResp.json().catch(function(){ return {}; });
      throw new Error('Sender account is not active on Stellar Testnet. Fund it via Friendbot first. (' + (errBody.detail || accountResp.status) + ')');
    }
    var accountData = await accountResp.json();

    var account = new StellarSdk.Account(sourcePublic, accountData.sequence);

    var txBuilder = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET
    })
      .addOperation(StellarSdk.Operation.payment({
        destination: recipient,
        asset:       StellarSdk.Asset.native(),
        amount:      amtStr
      }))
      .addMemo(StellarSdk.Memo.text(note.substring(0, 28)))
      .setTimeout(180);

    var tx = txBuilder.build();
    var txXdr;

    if (useFreighter) {
      var xdrUnsigned = tx.toXDR();
      var api = getFreighterAPI();
      var signResult = await api.signTransaction(xdrUnsigned, {
        networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
        network: 'TESTNET'
      });
      if (typeof signResult === 'string') {
        txXdr = signResult;
      } else if (signResult && signResult.signedTxXdr) {
        txXdr = signResult.signedTxXdr;
      } else if (signResult && signResult.xdr) {
        txXdr = signResult.xdr;
      } else {
        throw new Error('Freighter returned an unexpected signing result');
      }
    } else {
      tx.sign(StellarSdk.Keypair.fromSecret(secretKey));
      txXdr = tx.toEnvelope().toXDR('base64');
    }

    var submitResp = await fetch('https://horizon-testnet.stellar.org/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'tx=' + encodeURIComponent(txXdr)
    });
    var submitData = await submitResp.json();

    if (!submitResp.ok || submitData.status === 400) {
      var extras = (submitData.extras && submitData.extras.result_codes) || {};
      throw new Error('Transaction failed: ' + (extras.transaction || submitData.title || 'Unknown Horizon error'));
    }

    var txHash = submitData.hash;
    STATE._balanceGraceUntil = Date.now() + 20000;

    var signingWalletIdx = -1;
    if (STATE.wallets) {
      for (var _wi = 0; _wi < STATE.wallets.length; _wi++) {
        if (STATE.wallets[_wi].publicKey === sourcePublic) { signingWalletIdx = _wi; break; }
      }
    }
    if (signingWalletIdx !== -1) {
      STATE.wallets[signingWalletIdx].xlmBalance = Math.max(0, (STATE.wallets[signingWalletIdx].xlmBalance || 0) - amt);
    }

    var newXLMBalance;
    if (sourcePublic === activePublic) {
      newXLMBalance = Math.max(0, (STATE.wallet.xlmBalance || 0) - amt);
      STATE.wallet.xlmBalance = newXLMBalance;
    } else {
      newXLMBalance = STATE.wallet.xlmBalance;
    }

    if (useFreighter && typeof FREIGHTER !== 'undefined' && FREIGHTER.xlmBalance !== null) {
      FREIGHTER.xlmBalance = Math.max(0, (FREIGHTER.xlmBalance || 0) - amt);
    }

    syncSpendableBalance();
    var _heroEl = document.getElementById('heroBalance');
    if (_heroEl) _heroEl.textContent = newXLMBalance.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4});
    var _profEl = document.getElementById('profileXLM');
    if (_profEl) _profEl.textContent = newXLMBalance.toLocaleString('en',{minimumFractionDigits:4}) + ' XLM';
    var _stelBal = document.getElementById('stellarXLMBal');
    if (_stelBal) _stelBal.textContent = newXLMBalance.toLocaleString('en',{minimumFractionDigits:4}) + ' XLM';
    if (useFreighter) updateFreighterUI();

    STATE.transactions.unshift({
      id:     'tx-' + txHash.substring(0, 8),
      type:   'send',
      name:   recipient.substring(0, 4) + '…' + recipient.slice(-4),
      amount: amt,
      status: 'synced',
      mode:   'online',
      note:   note,
      txHash: txHash,
      ts:     Date.now(),
      icon:   '💸'
    });

    syncSenderTxsToFirestore();

    var sendBal = document.getElementById('sendBal');
    if (sendBal) sendBal.textContent = (STATE.balance || 0).toFixed(6) + ' XLM';
    document.getElementById('sendRecipient').value = '';
    document.getElementById('sendAmount').value    = '';
    if (document.getElementById('sendNote')) document.getElementById('sendNote').value = '';

    saveSession();
    renderHistory('all'); // refresh history tab immediately so the log appears

    document.getElementById('successAmt').textContent      = fmtAmt(amt) + ' XLM';
    document.getElementById('successMerchant').textContent = 'Sent to ' + recipient.substring(0,4) + '…' + recipient.slice(-4);
    document.getElementById('successMode').textContent     = '✅ Settled on Stellar Testnet';
    document.getElementById('successMode').className       = 'badge mt-12 badge-green';
    document.getElementById('proofCode').textContent       = 'TX: ' + txHash;

    var proofEl = document.getElementById('proofCode');
    if (proofEl) {
      proofEl.dataset.txhash = txHash;
      proofEl.innerHTML = 'TX: <a href="https://stellar.expert/explorer/testnet/tx/' + encodeURIComponent(String(txHash))
        + '" target="_blank" rel="noopener noreferrer" style="color:var(--primary);word-break:break-all;font-size:10px;">'
        + safeText(txHash) + '</a>';
    }

    var mScore = Math.floor(Math.random() * 40) + 50;
    document.getElementById('mTrustScore').textContent = mScore;

    showLoading(false);
    if (btn) { btn.disabled = false; btn.textContent = '⭐ Send XLM →'; }
    showModal('successModal');

    var shortAddr = recipient.substring(0,4) + '…' + recipient.slice(-4);
    showAlert('success', '💸 Sent ' + amt.toFixed(4) + ' XLM → ' + shortAddr + ' · Settled on Stellar');

  } catch (err) {
    showLoading(false);
    if (btn) { btn.disabled = false; btn.textContent = '⭐ Send XLM →'; }
    showAlert('red', '❌ ' + (err.message || 'Stellar transaction failed'));
  }
}

function setTransfer(method) {
  STATE.transferMethod = method;
  ['QR','BT','NFC','SMS'].forEach(function(m){
    var el = document.getElementById('tr'+m);
    if (!el) return;
    el.style.background  = m === method ? 'var(--primary-light)' : '';
    el.style.borderColor = m === method ? 'var(--primary)' : '';
    el.style.color       = m === method ? 'var(--primary)' : '';
  });
}

function doOfflinePay() {
  var amtInput      = document.getElementById('offlineAmount');
  var merchantInput = document.getElementById('offlineMerchant');
  var amt      = parseFloat(amtInput.value);
  var merchant = merchantInput.value.trim() || 'Unknown Merchant';
  if (!isFinite(amt) || amt <= 0)            { showAlert('red','⚠️ Enter payment amount'); return; }
  if (amt > STATE.vaultLocked)     { showAlert('red','❌ Exceeds offline vault balance'); return; }
  if (STATE.vaultUsesRemaining <= 0){ showAlert('red','🔄 Max uses reached! Sync first.'); return; }

  var availNonce = null;
  for (var i = 0; i < STATE.noncePool.length; i++) {
    if (STATE.usedNonces.indexOf(STATE.noncePool[i]) === -1) { availNonce = STATE.noncePool[i]; break; }
  }
  if (!availNonce) { showAlert('orange','⚠️ Nonce pool exhausted. Sync required.'); return; }

  STATE.usedNonces.push(availNonce);
  STATE.monoCounter++;
  STATE.vaultLocked -= amt;
  STATE.vaultUsesRemaining = Math.max(0, STATE.vaultUsesRemaining - 1);

  var newTx = {
    id: 'tx'+Date.now(), type:'send', name: merchant, amount: amt,
    status: 'pending', mode: 'offline', note: 'Offline via '+STATE.transferMethod,
    ts: Date.now(), icon: '📴'
  };
  STATE.transactions.unshift(newTx);
  STATE.pendingTxCount++;

  renderNonces();
  updateOfflinePayUI();
  amtInput.value = ''; merchantInput.value = '';
  doPaymentSuccess(amt, merchant, 'offline', availNonce);
}

function doPaymentSuccess(amt, merchant, mode, nonce) {
  var n = nonce || Math.floor(Math.random()*900)+100;
  var txHash = btoa(merchant+amt+Date.now()).substring(0,12);
  document.getElementById('successAmt').textContent      = fmtAmt(amt);
  document.getElementById('successMerchant').textContent = 'Sent to '+merchant;
  document.getElementById('successMode').textContent     = mode==='offline'?'📴 Offline Payment · Pending Sync':'✅ Online · Settled on Stellar';
  document.getElementById('successMode').className       = 'badge mt-12 '+(mode==='offline'?'badge-purple':'badge-green');
  document.getElementById('proofCode').textContent       = 'OmniPay:nonce='+String(n).padStart(3,'0')+':amt='+amt+':vault=0xA4B2:counter='+STATE.monoCounter+':sig=3045022100'+txHash.toUpperCase()+'...';
  var mScore = Math.floor(Math.random()*40)+50;
  document.getElementById('mTrustScore').textContent = mScore;

  if (mode === 'online' && amt <= STATE.balance) {
    if (STATE.wallet) {
      STATE.wallet.xlmBalance = Math.max(0, (STATE.wallet.xlmBalance || 0) - amt);
      if (STATE.wallets && typeof STATE.activeWalletIndex === 'number' && STATE.wallets[STATE.activeWalletIndex]) {
        STATE.wallets[STATE.activeWalletIndex].xlmBalance = STATE.wallet.xlmBalance;
      }
    }
    STATE._balanceGraceUntil = Date.now() + 20000;
    syncSpendableBalance();
    var _heroEl2 = document.getElementById('heroBalance');
    if (_heroEl2) _heroEl2.textContent = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4});
    var _profEl2 = document.getElementById('profileXLM');
    if (_profEl2) _profEl2.textContent = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4}) + ' XLM';
    var _stelBal2 = document.getElementById('stellarXLMBal');
    if (_stelBal2) _stelBal2.textContent = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4}) + ' XLM';
    STATE.transactions.unshift({
      id: 'tx'+Date.now(), type:'send', name: merchant, amount: amt,
      status: 'synced', mode: 'online',
      note: document.getElementById('sendNote') ? (document.getElementById('sendNote').value||'Online payment') : 'Online payment',
      ts: Date.now(), icon: '💸'
    });
    var sendR = document.getElementById('sendRecipient');
    var sendN = document.getElementById('sendNote');
    if (sendR) sendR.value = '';
    if (sendN) sendN.value = '';
  }
  saveSession();
  showModal('successModal');
}

function showLockModal() {
  var t   = getTrustTier(STATE.trustScore);
  var max = Math.floor(STATE.balance * t.pct / 100);
  document.getElementById('lockTrustScore').textContent = STATE.trustScore;
  document.getElementById('lockAllowedPct').textContent = t.pct+'%';
  document.getElementById('lockMaxAmt').textContent     = fmtAmt(max);
  var lockAmtEl = document.getElementById('lockAmount');
  if (lockAmtEl) lockAmtEl.value = '';
  showModal('lockModal');
}

function showUnlockModal() {
  var amt = prompt('Enter amount to unlock (max '+fmtAmt(STATE.vaultLocked)+'):');
  var n = parseFloat(amt);
  if (!n || n <= 0) return;
  if (n > STATE.vaultLocked) { showAlert('red','❌ Exceeds locked amount'); return; }
  STATE.vaultLocked -= n;
  renderVault();
  showAlert('success','🔓 '+fmtAmt(n)+' unlocked from vault');
}

function doLockFunds() {
  var amt = parseFloat(document.getElementById('lockAmount').value);
  var t   = getTrustTier(STATE.trustScore);
  var max = Math.floor(STATE.balance * t.pct / 100);
  if (!isFinite(amt) || amt <= 0)                          { showAlert('red','⚠️ Enter amount to lock'); return; }
  if (amt > STATE.balance - STATE.vaultLocked)   { showAlert('red','❌ Insufficient free balance'); return; }
  if (amt + STATE.vaultLocked > max)             { showAlert('red','❌ Exceeds trust-based limit of '+fmtAmt(max)); return; }
  STATE.vaultLocked += amt;
  var usesT = t.uses === 99 ? 99 : t.uses;
  STATE.vaultUsesTotal     = usesT;
  STATE.vaultUsesRemaining = usesT;
  closeModal('lockModal');
  renderVault();
  showAlert('success','🔒 '+fmtAmt(amt)+' locked to Stellar vault!');
}

function doSync() {
  var pending = STATE.transactions.filter(function(tx){ return tx.status === 'pending'; });
  if (pending.length === 0) { showAlert('yellow','✅ Nothing to sync — all transactions settled!'); return; }

  var results = [];
  pending.forEach(function(tx){
    var isDuplicate = STATE.usedNonces.filter(function(n){ return n === tx.nonce; }).length > 1;
    if (isDuplicate) {
      tx.status = 'failed';
      results.push({ tx: tx, result: 'FRAUD', reason: 'Duplicate nonce detected' });
      STATE.trustScore = Math.max(0, STATE.trustScore - 10);
    } else {
      tx.status = 'synced';
      results.push({ tx: tx, result: 'OK' });
      STATE.goodTxCount++;
      STATE.trustScore = Math.min(100, STATE.trustScore + 2);
    }
  });

  STATE.pendingTxCount = 0;
  var t = getTrustTier(STATE.trustScore);
  STATE.vaultUsesTotal     = t.uses === 99 ? 99 : t.uses;
  STATE.vaultUsesRemaining = t.uses === 99 ? 99 : t.uses;

  var syncResultsEl = document.getElementById('syncResults');
  syncResultsEl.innerHTML = results.map(function(r){
    return '<div class="card" style="padding:14px 16px; margin-bottom:8px; background:'+(r.result==='OK'?'#D4F7EC':'#FFE0E3')+'"><div style="font-size:13px; font-weight:700; color:var(--text);">'+safeText(r.tx.name)+'</div><div style="font-size:12px; color:'+(r.result==='OK'?'var(--success)':'var(--danger)')+'; margin-top:4px; font-weight:600;">'+(r.result==='OK'?'✅ Settled on Stellar':'❌ Rejected — '+safeText(r.reason))+'</div><div style="font-size:12px; color:var(--text-muted); margin-top:2px; font-weight:500;">'+fmtAmt(r.tx.amount)+'</div></div>';
  }).join('') + '<div style="margin-top:12px; padding:14px; background:var(--primary-light); border-radius:14px; text-align:center;"><div style="font-size:13px; font-weight:700; color:var(--primary);">New Trust Score: '+STATE.trustScore+'/100</div><div style="font-size:12px; color:var(--primary); opacity:0.75; margin-top:2px; font-weight:600;">'+t.icon+' '+t.tier+' tier</div></div>';

  showModal('syncModal');
}

function toggleOfflineMode() {
  document.getElementById('offlineToggle').classList.toggle('on');
  STATE.isOnline    = !STATE.isOnline;
  STATE.offlineMode = !STATE.offlineMode;

  var statusEl    = document.getElementById('connectStatus');
  var payStatus   = document.getElementById('payStatusBadge');
  var payLabel    = document.getElementById('payModeLabel');
  var heroPending = document.getElementById('heroPending');

  if (!STATE.isOnline) {
    statusEl.className   = 'status-badge offline';
    statusEl.innerHTML   = '<span class="status-dot offline"></span>Offline Mode';
    if (payStatus)   { payStatus.className = 'status-badge offline'; payStatus.innerHTML = '<span class="status-dot offline"></span>Offline'; }
    if (payLabel)    payLabel.textContent = 'Offline Mode · Payments stored locally';
    if (heroPending) heroPending.textContent = 'Offline';
    showAlert('orange','📴 Offline mode activated — payments stored locally');
  } else {
    statusEl.className   = 'status-badge online';
    statusEl.innerHTML   = '<span class="status-dot online"></span>Online · Stellar Testnet';
    if (payStatus)   { payStatus.className = 'status-badge online'; payStatus.innerHTML = '<span class="status-dot online"></span>Online'; }
    if (payLabel)    payLabel.textContent = 'Online Mode · Instant Settlement';
    if (heroPending) heroPending.textContent = 'Online';
    showAlert('success','✅ Back online — syncing to Stellar…');
    setTimeout(doSync, 1500);
  }
}

function switchPayTab(tab, el) {
  document.querySelectorAll('.pay-tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.pay-panel').forEach(function(p){ p.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById('panel-'+tab).classList.add('active');
  if (tab === 'send') syncSpendableBalance();
}

function showFirebaseError(msg, code) {
  var box     = document.getElementById('wsErrorBox');
  var msgEl   = document.getElementById('wsErrorMsg');
  var codeEl  = document.getElementById('wsErrorCode');
  if (!box) return;
  box.style.display    = 'block';
  msgEl.textContent    = msg.replace(/^❌\s*/, '');
  codeEl.textContent   = code ? 'Error code: ' + code : '';
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideFirebaseError() {
  var box = document.getElementById('wsErrorBox');
  if (box) box.style.display = 'none';
}

var alertTimer;
function showAlert(type, msg) {
  clearTimeout(alertTimer);
  var banner = document.getElementById('alertBanner');
  var msgEl  = document.getElementById('alertMsg');
  var iconEl = document.getElementById('alertIcon');
  banner.className = 'alert-banner '+type;
  msgEl.textContent  = msg;
  iconEl.textContent = type==='success'?'✅':type==='red'?'🚨':type==='orange'?'🟠':'⚠️';
  banner.classList.add('show');
  alertTimer = setTimeout(function(){ banner.classList.remove('show'); }, 3500);
}

function showModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function showReceiveModal() {
  if (!STATE.isLoggedIn) { showAlert('orange','⚠️ Please log in first'); return; }
  showReceiveStep1();
  showModal('receiveModal');
}

function showReceiveStep1() {
  var s1 = document.getElementById('receiveStep1');
  var s2 = document.getElementById('receiveStep2');
  if (s1) s1.style.display = '';
  if (s2) s2.style.display = 'none';
  var key = STATE.wallet.publicKey || '';
  var recvKey   = document.getElementById('receiveWalletKey');
  var recvTrust = document.getElementById('receiveTrustScore');
  if (recvKey)   recvKey.textContent   = key || '—';
  if (recvTrust) recvTrust.textContent = STATE.trustScore + '/100';
  var amtEl = document.getElementById('receiveAmountInput');
  if (amtEl) amtEl.value = '';
  var convEl = document.getElementById('receiveConvDisplay');
  if (convEl) convEl.textContent = '';
}

var _recvConvTimer = null;
var _recvConvToken = 0;
function updateReceiveConversion() {
  var el  = document.getElementById('receiveConvDisplay');
  var amt = parseFloat((document.getElementById('receiveAmountInput') || {}).value) || 0;
  if (!el) return;
  if (!amt || amt <= 0) { el.textContent = ''; return; }
  el.innerHTML = '<span style="opacity:0.6;">Loading rate…</span>';
  clearTimeout(_recvConvTimer);
  _recvConvTimer = setTimeout(_renderReceiveConversion, 350);
}

async function _renderReceiveConversion() {
  var el = document.getElementById('receiveConvDisplay');
  if (!el) return;
  var myTok = ++_recvConvToken;
  var amt   = parseFloat((document.getElementById('receiveAmountInput') || {}).value) || 0;
  if (!amt) { el.textContent = ''; return; }
  var cfg      = _getCountryConfig(STATE.user && STATE.user.country);
  var fallback = XLM_RATES[cfg.cur.toUpperCase()] || getUserCurrency();
  var rate     = null;
  try {
    var rc = new AbortController();
    var rt = setTimeout(function(){ rc.abort(); }, 6000);
    var r  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=' + cfg.cur, { signal: rc.signal });
    clearTimeout(rt);
    if (r.ok) { var d = await r.json(); rate = (d.stellar && d.stellar[cfg.cur]) ? parseFloat(d.stellar[cfg.cur]) : null; }
  } catch(_) {}
  if (rate === null) {
    try {
      var rc2 = new AbortController();
      var rt2 = setTimeout(function(){ rc2.abort(); }, 6000);
      var r2  = await fetch('https://min-api.cryptocompare.com/data/price?fsym=XLM&tsyms=' + cfg.cur.toUpperCase(), { signal: rc2.signal });
      clearTimeout(rt2);
      if (r2.ok) { var d2 = await r2.json(); rate = d2[cfg.cur.toUpperCase()] ? parseFloat(d2[cfg.cur.toUpperCase()]) : null; }
    } catch(_) {}
  }
  if (myTok !== _recvConvToken) return;
  var usedFallback = false;
  if (rate === null) { rate = fallback.rate; usedFallback = true; }
  var total     = amt * rate;
  var formatted = total >= 1000 ? total.toLocaleString('en', {maximumFractionDigits:2}) : total.toFixed(2);
  var tag       = usedFallback ? 'approx., offline' : 'live rate';
  el.innerHTML = '<span style="color:var(--success);">≈ ' + cfg.sym + formatted + ' ' + cfg.coin + '</span>'
    + ' <span style="opacity:0.6;font-size:11px;">(' + tag + ')</span>';
  el.dataset.equiv  = cfg.sym + formatted + ' ' + cfg.coin;
  el.dataset.cur    = cfg.cur.toUpperCase();
  el.dataset.rate   = rate;
}

async function generateReceiveQR() {
  var amtEl = document.getElementById('receiveAmountInput');
  var amt   = parseFloat(amtEl ? amtEl.value : 0);
  if (!isFinite(amt) || amt <= 0) { showAlert('red','⚠️ Enter an amount first'); if (amtEl) amtEl.focus(); return; }

  var convEl = document.getElementById('receiveConvDisplay');
  if (!convEl.dataset.rate) { await _renderReceiveConversion(); }

  var key    = STATE.wallet.publicKey || '';
  var label  = encodeURIComponent((STATE.user && STATE.user.name) || STATE.uid || 'OmniPay User');
  var equiv  = convEl.dataset.equiv || '';
  var cur    = convEl.dataset.cur   || 'PHP';

  var qrData = 'omnipay:' + key + '?amount=' + amt.toFixed(7) + '&label=' + label
    + (equiv ? '&equiv=' + encodeURIComponent(equiv) : '')
    + (cur   ? '&cur='   + cur : '');

  var s1 = document.getElementById('receiveStep1');
  var s2 = document.getElementById('receiveStep2');
  if (s1) s1.style.display = 'none';
  if (s2) s2.style.display = '';

  var amtBig  = document.getElementById('receiveAmtBig');
  var equivBig = document.getElementById('receiveEquivBig');
  if (amtBig)  amtBig.textContent  = amt.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:7}) + ' XLM';
  if (equivBig) equivBig.textContent = equiv ? '≈ ' + equiv : '';

  var key2El = document.getElementById('receiveWalletKey2');
  if (key2El) key2El.textContent = key;

  var container = document.getElementById('receiveQRContainer');
  if (container) {
    container.innerHTML = '';
    if (key && typeof QRCode !== 'undefined') {
      try {
        new QRCode(container, {
          text: qrData,
          width: 180, height: 180,
          colorDark: '#1E3A5F', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
        var logo = document.createElement('img');
        logo.src = 'OMNIPAY LOGO 1.png'; logo.alt = 'OmniPay';
        logo.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'
          + 'width:60px;height:60px;object-fit:contain;background:#fff;border-radius:12px;'
          + 'padding:6px;box-shadow:0 3px 10px rgba(0,0,0,0.28);border:3px solid #fff;';
        logo.onerror = function(){ logo.style.display = 'none'; };
        container.style.position = 'relative';
        container.appendChild(logo);
      } catch(e) {
        container.innerHTML = '<div style="font-size:9px;font-family:monospace;color:#1E3A5F;word-break:break-all;padding:8px;font-weight:700;">' + safeText(key) + '</div>';
      }
    }
  }
}

function showBiometricModal() { showModal('biometricModal'); }

function showStellarInfoModal() {
  document.getElementById('monoCounter').textContent        = STATE.monoCounter;
  document.getElementById('stellarPubKeyShort').textContent = STATE.wallet.publicKey || '—';
  document.getElementById('stellarXLMBal').textContent      = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4})+' XLM';
  var contract = STATE.wallet.contractAddress || 'C3XQABCDEF5678SOROBAN9PRT';
  document.getElementById('stellarContractAddr').textContent = contract.length > 8 ? contract.substring(0,4)+'…'+contract.slice(-4) : contract;
  showModal('stellarModal');
}

function showFilterModal() { showAlert('yellow','🔽 Use the filter chips above to sort transactions'); }

function showMapModal() { showModal('mapModal'); }

function showChangePasswordModal() {
  document.getElementById('cpCurrent').value = '';
  document.getElementById('cpNew').value      = '';
  document.getElementById('cpConfirm').value  = '';
  showModal('changePasswordModal');
}

async function doChangePassword() {
  var current = document.getElementById('cpCurrent').value;
  var newPass = document.getElementById('cpNew').value;
  var confirm = document.getElementById('cpConfirm').value;

  if (!current)  { showAlert('red','⚠️ Enter your current password'); return; }
  if (!newPass || newPass.length < 6) { showAlert('orange','🔐 New password must be at least 6 characters'); return; }
  if (!/\d/.test(newPass)) { showAlert('orange','🔢 New password must contain at least one number'); return; }
  if (newPass !== confirm) { showAlert('red','⚠️ New password and confirmation do not match'); return; }

  var btn = document.getElementById('cpSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  showLoading(true, 'Verifying current password…');

  if (!auth || !auth.currentUser) {
    showLoading(false);
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
    showAlert('red','❌ Your session has expired. Sign in again.');
    return;
  }

  try {
    var credential = firebase.auth.EmailAuthProvider.credential(auth.currentUser.email, current);
    await auth.currentUser.reauthenticateWithCredential(credential);
    await auth.currentUser.updatePassword(newPass);
  } catch (e) {
    showLoading(false);
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
    var message = /wrong-password|invalid-credential|invalid-login-credentials/i.test(e.code || '')
      ? '❌ Current password is incorrect'
      : '❌ Could not update password. Sign in again and retry.';
    showAlert('red', message);
    return;
  }
  showLoading(false);
  if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }

  closeModal('changePasswordModal');
  showAlert('success','✅ Password updated successfully!');
}

function copyWalletAddress() {
  if (navigator.clipboard && STATE.wallet.publicKey) {
    navigator.clipboard.writeText(STATE.wallet.publicKey).then(function(){
      showAlert('success','📋 Wallet address copied!');
    }).catch(function(){ showAlert('success','📋 Address copied!'); });
  } else {
    showAlert('success','📋 Address: '+(STATE.wallet.publicKey||'').substring(0,16)+'…');
  }
  closeModal('receiveModal');
}

async function saveRecipientTxToFirestore(recipientAddress, amtXLM, txHash, senderNote) {
  // A client must never update another user's profile. A trusted backend
  // trigger should append the recipient transaction after settlement.
  return false;
}

var _inboxUnsubscribe = null;  // Firestore onSnapshot cleanup function
var _knownTxIds = new Set();   // IDs already present in STATE — skip on first snapshot

function startInboxListener() {
  if (!db || !STATE.uid || !STATE.isLoggedIn) return;
  stopInboxListener(); // tear down any previous listener first

  normalizeTransactionState();
  _knownTxIds = new Set(STATE.transactions.map(function(tx){ return tx.id; }));

  try {
    _inboxUnsubscribe = db.collection(USERS_COLLECTION)
      .doc(STATE.uid)
      .onSnapshot(function(doc) {
        if (!doc.exists || !STATE.isLoggedIn) return;
        var data      = doc.data();
        var remoteTxs = dedupeTransactions(data.transactions);

        var incoming = remoteTxs.filter(function(tx){ return tx.id && !_knownTxIds.has(tx.id); });
        if (incoming.length === 0) return;

        incoming.forEach(function(tx){ _knownTxIds.add(tx.id); });

        STATE.transactions = dedupeTransactions(incoming.concat(STATE.transactions));
        saveSession();

        var histEl = document.getElementById('history');
        if (histEl && histEl.classList.contains('active')) {
          renderHistory('all');
        }

        incoming
          .filter(function(tx){ return tx.type === 'receive'; })
          .forEach(function(tx){
            var senderName = (tx.name || 'someone').replace(/^From\s*/i, '');
            var amt        = (tx.amount || 0).toFixed(4);
            showAlert('success', '💰 Received ' + amt + ' XLM from ' + senderName + '!');
          });
      }, function(err){
        console.warn('OmniPay inbox listener error:', err);
      });
  } catch(e) {
    console.warn('startInboxListener failed:', e);
  }
}

function stopInboxListener() {
  if (typeof _inboxUnsubscribe === 'function') {
    try { _inboxUnsubscribe(); } catch(_) {}
    _inboxUnsubscribe = null;
  }
  _knownTxIds = new Set();
}

async function syncSenderTxsToFirestore() {
  if (!db || !STATE.uid) return;
  try {
    var txs = dedupeTransactions(STATE.transactions).slice(0, 200); // cap at 200
    await db.collection(USERS_COLLECTION).doc(STATE.uid).update({
      transactions: txs
    });
  } catch(e) {
    console.warn('syncSenderTxsToFirestore error:', e);
  }
}

function copyProofCode() {
  var el   = document.getElementById('proofCode');
  var text = el ? (el.dataset.txhash || (el.textContent || el.innerText || '').trim()) : '';
  if (!text) { showAlert('yellow','⚠️ Nothing to copy'); return; }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function(){
      showAlert('success','📋 TX hash copied! Paste it on Stellar Explorer.');
    }).catch(function(){
      showAlert('success','📋 Copied: '+text.substring(0,20)+'…');
    });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showAlert('success','📋 TX hash copied!'); }
    catch(e) { showAlert('yellow','📋 Long-press to copy: '+text.substring(0,20)+'…'); }
    document.body.removeChild(ta);
  }
}

var THEME = { dark: false };

function applyTheme(dark) {
  var app  = document.getElementById('app');
  var body = document.body;
  var btn  = document.getElementById('themeToggleBtn');
  THEME.dark = dark;
  if (dark) {
    app.classList.add('dark');
    body.classList.add('dark-body');
    if (btn) btn.textContent = '☀️';
  } else {
    app.classList.remove('dark');
    body.classList.remove('dark-body');
    if (btn) btn.textContent = '🌙';
  }
  try { localStorage.setItem('omnipay_theme', dark ? 'dark' : 'light'); } catch(e) {}
}

function toggleTheme() {
  applyTheme(!THEME.dark);
}

function initTheme() {
  var saved = 'light';
  try { saved = localStorage.getItem('omnipay_theme') || 'light'; } catch(e) {}
  applyTheme(saved === 'dark');
}

var STELLAR_HORIZON_TESTNET = 'https://horizon-testnet.stellar.org';
var STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

var FREIGHTER = {
  isConnected: false,
  publicKey: '',
  xlmBalance: null   // null = not fetched, number = fetched
};

function getFreighterAPI() {
  if (typeof window.freighterApi !== 'undefined') return window.freighterApi;
  if (typeof window.freighter    !== 'undefined') return window.freighter;
  return null;
}

async function connectFreighterWallet() {
  var api = getFreighterAPI();
  var btn = document.getElementById('freighterConnectBtn');

  if (!api) {
    showAlert('orange', '🦊 Freighter not installed! Visit freighter.app');
    if (confirm('Freighter browser extension not found. Open freighter.app to install it?')) {
      window.open('https://freighter.app', '_blank', 'noopener,noreferrer');
    }
    return;
  }

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    showLoading(true, 'Connecting Freighter wallet…');

    var publicKey;
    if (typeof api.requestAccess === 'function') {
      var res = await api.requestAccess();
      publicKey = (res && res.publicKey) ? res.publicKey : (typeof res === 'string' ? res : null);
    } else if (typeof api.getPublicKey === 'function') {
      publicKey = await api.getPublicKey();
    } else {
      throw new Error('Incompatible Freighter API version');
    }

    if (!publicKey) throw new Error('No public key returned by Freighter');

    FREIGHTER.isConnected = true;
    FREIGHTER.publicKey   = publicKey;

    await refreshFreighterBalance();

    showLoading(false);
    updateFreighterUI();
    showAlert('success', '✅ Freighter connected! Balance fetched.');

  } catch (e) {
    showLoading(false);
    FREIGHTER.isConnected = false;
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect Freighter'; }
    var msg = e.message || String(e);
    if (/declin|reject|cancel|denied/i.test(msg)) {
      showAlert('orange', '⚠️ Connection declined — please approve in Freighter');
    } else {
      showAlert('red', '❌ Freighter error: ' + msg.substring(0, 70));
    }
  }
}

function disconnectFreighterWallet() {
  FREIGHTER.isConnected = false;
  FREIGHTER.publicKey   = '';
  FREIGHTER.xlmBalance  = null;
  updateFreighterUI();
  showAlert('yellow', '👋 Freighter wallet disconnected');
}

async function refreshFreighterBalance() {
  if (!FREIGHTER.publicKey) return;
  try {
    var resp = await fetch(STELLAR_HORIZON_TESTNET + '/accounts/' + FREIGHTER.publicKey);
    if (resp.status === 404) {
      FREIGHTER.xlmBalance = 0;
    } else if (!resp.ok) {
      throw new Error('Horizon HTTP ' + resp.status);
    } else {
      var data = await resp.json();
      var native = (data.balances || []).find(function(b) { return b.asset_type === 'native'; });
      FREIGHTER.xlmBalance = native ? parseFloat(native.balance) : 0;
    }
  } catch (e) {
    FREIGHTER.xlmBalance = null;
    showAlert('orange', '⚠️ Could not fetch XLM balance: ' + (e.message || e));
  }
  updateFreighterUI();
}

function updateFreighterUI() {
  var connBadge      = document.getElementById('freighterConnBadge');
  var xlmDisplay     = document.getElementById('freighterXLMDisplay');
  var balLbl         = document.getElementById('freighterBalLbl');
  var keyDisplay     = document.getElementById('freighterKeyDisplay');
  var connectBtn     = document.getElementById('freighterConnectBtn');
  var disconnectBtn  = document.getElementById('freighterDisconnectBtn');
  var refreshBtn     = document.getElementById('freighterRefreshBtn');
  var sendXLMBtn     = document.getElementById('sendXLMBtn');
  var heroXLMChip    = document.getElementById('heroXLMChip');
  var heroXLMBal     = document.getElementById('heroXLMBal');

  if (FREIGHTER.isConnected) {
    if (connBadge) { connBadge.textContent = '● Connected'; connBadge.style.color = '#2ED573'; }

    var balStr = FREIGHTER.xlmBalance !== null
      ? FREIGHTER.xlmBalance.toLocaleString('en', { minimumFractionDigits: 4, maximumFractionDigits: 7 }) + ' XLM'
      : 'Fetching…';
    if (xlmDisplay) { xlmDisplay.textContent = balStr; xlmDisplay.className = 'freighter-live-xlm live'; }
    if (balLbl)     balLbl.textContent = 'Live balance · Stellar Testnet (Freighter)';

    var shortKey = FREIGHTER.publicKey.substring(0, 12) + '…' + FREIGHTER.publicKey.slice(-8);
    if (keyDisplay) keyDisplay.textContent = FREIGHTER.publicKey;

    if (connectBtn)    { connectBtn.style.display = 'none'; }
    if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
    if (refreshBtn)    refreshBtn.style.display    = 'inline-block';

    if (sendXLMBtn) sendXLMBtn.style.display = 'block';

    if (heroXLMChip && FREIGHTER.xlmBalance !== null) {
      heroXLMChip.style.display = 'inline-flex';
      if (heroXLMBal) heroXLMBal.textContent = FREIGHTER.xlmBalance.toLocaleString('en', { minimumFractionDigits: 4 }) + ' XLM';
    }

  } else {
    if (connBadge) { connBadge.textContent = '● Not connected'; connBadge.style.color = 'rgba(255,255,255,0.4)'; }
    if (xlmDisplay) { xlmDisplay.textContent = '— XLM'; xlmDisplay.className = 'freighter-live-xlm idle'; }
    if (balLbl)     balLbl.textContent = 'Connect Freighter to see live balance';
    if (keyDisplay) keyDisplay.textContent = 'Wallet address will appear here after connecting';
    if (connectBtn)    { connectBtn.style.display = 'inline-block'; connectBtn.disabled = false; connectBtn.textContent = '🔗 Connect Freighter'; }
    if (disconnectBtn) disconnectBtn.style.display = 'none';
    if (refreshBtn)    refreshBtn.style.display    = 'none';
    if (sendXLMBtn)    sendXLMBtn.style.display    = 'none';
    if (heroXLMChip)   heroXLMChip.style.display   = 'none';
  }
}

async function showSendXLMModal() {
  if (!FREIGHTER.isConnected) {
    showAlert('orange', '⚠️ Connect your Freighter wallet first');
    navTo('profile');
    return;
  }
  showLoading(true, 'Fetching latest balance…');
  await refreshFreighterBalance();
  showLoading(false);

  var shortKey = FREIGHTER.publicKey.substring(0,10) + '…' + FREIGHTER.publicKey.slice(-6);
  var fromEl   = document.getElementById('xlmSendFrom');
  var balEl    = document.getElementById('xlmAvailBal');
  if (fromEl) fromEl.textContent = shortKey;
  if (balEl)  balEl.textContent  = FREIGHTER.xlmBalance !== null
    ? FREIGHTER.xlmBalance.toLocaleString('en', { minimumFractionDigits: 4 }) + ' XLM'
    : '—';

  ['xlmDestination','xlmAmount','xlmMemo'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.value = ''; el.classList.remove('error'); }
  });
  var resultEl = document.getElementById('xlmTxResult');
  if (resultEl) resultEl.style.display = 'none';
  var sendBtn = document.getElementById('xlmSendBtn');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Send XLM'; }

  showModal('sendXLMModal');
}

async function doSendXLM() {
  var destEl   = document.getElementById('xlmDestination');
  var amtEl    = document.getElementById('xlmAmount');
  var memoEl   = document.getElementById('xlmMemo');
  var sendBtn  = document.getElementById('xlmSendBtn');

  var dest   = normalizeStellarPublicKey(destEl ? destEl.value : '');
  var amount = amtEl    ? amtEl.value.trim()     : '';
  var memo   = memoEl   ? memoEl.value.trim()    : '';

  if (!dest) {
    if (destEl) destEl.classList.add('error');
    showAlert('red', '⚠️ Enter a destination address');
    return;
  }
  if (!isValidStellarPublicKey(dest)) {
    if (destEl) destEl.classList.add('error');
    showAlert('red', '❌ ' + stellarAddressError(dest));
    return;
  }
  if (destEl) destEl.value = dest;
  if (!amount || !isFinite(parseFloat(amount)) || parseFloat(amount) <= 0) {
    if (amtEl) amtEl.classList.add('error');
    showAlert('red', '⚠️ Enter a valid XLM amount');
    return;
  }

  var amtNum = parseFloat(parseFloat(amount).toFixed(7));

  if (FREIGHTER.xlmBalance !== null && amtNum + 1 > FREIGHTER.xlmBalance) {
    if (amtEl) amtEl.classList.add('error');
    showAlert('red', '❌ Insufficient balance (keep ≥ 1 XLM as reserve)');
    return;
  }

  if (!FREIGHTER.isConnected || !FREIGHTER.publicKey) {
    showAlert('orange', '⚠️ Freighter wallet not connected');
    return;
  }

  if (typeof StellarSdk === 'undefined') {
    showAlert('red', '❌ Stellar SDK not loaded. Refresh the page and try again.');
    return;
  }

  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Building transaction…'; }
  var resultEl = document.getElementById('xlmTxResult');
  if (resultEl) resultEl.style.display = 'none';

  try {
    showLoading(true, 'Loading account from Horizon…');
    if (!(await stellarAccountExists(dest))) {
      throw new Error('Recipient wallet is not activated on Stellar Testnet. Ask the recipient to fund or activate the account first.');
    }
    var accountResp = await fetch(STELLAR_HORIZON_TESTNET + '/accounts/' + FREIGHTER.publicKey);
    if (!accountResp.ok) throw new Error('Could not load account (HTTP ' + accountResp.status + '). Is it funded?');
    var accountData = await accountResp.json();

    showLoading(true, 'Building transaction…');
    var sourceAccount = new StellarSdk.Account(accountData.id, accountData.sequence);
    var txBuilder     = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee:               StellarSdk.BASE_FEE,
      networkPassphrase: STELLAR_TESTNET_PASSPHRASE
    });

    txBuilder.addOperation(
      StellarSdk.Operation.payment({
        destination: dest,
        asset:       StellarSdk.Asset.native(),
        amount:      amtNum.toFixed(7)
      })
    );

    if (memo) {
      txBuilder.addMemo(StellarSdk.Memo.text(memo.substring(0, 28)));
    }

    txBuilder.setTimeout(30);
    var transaction = txBuilder.build();
    var xdr         = transaction.toXDR();

    showLoading(true, 'Waiting for Freighter approval…');
    var api = getFreighterAPI();
    if (!api) throw new Error('Freighter extension not found');

    var signResult = await api.signTransaction(xdr, {
      networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
      network:           'TESTNET'
    });

    var signedXDR;
    if (typeof signResult === 'string') {
      signedXDR = signResult;
    } else if (signResult && signResult.signedTxXdr) {
      signedXDR = signResult.signedTxXdr;
    } else if (signResult && signResult.xdr) {
      signedXDR = signResult.xdr;
    } else {
      throw new Error('Freighter returned an unexpected signing result');
    }

    showLoading(true, 'Submitting to Stellar Testnet…');
    var submitResp = await fetch(STELLAR_HORIZON_TESTNET + '/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'tx=' + encodeURIComponent(signedXDR)
    });
    var submitData = await submitResp.json();

    showLoading(false);
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Send XLM'; }

    if (submitData.successful === true) {
      var txHash = submitData.hash || '';
      renderXLMTxResult(true, txHash, amtNum, dest, '');

      STATE.transactions.unshift({
        id:     'xlm-' + Date.now(),
        type:   'send',
        name:   'XLM Transfer · Freighter',
        amount: amtNum * 50,   // rough PHP equivalent shown
        status: 'synced',
        mode:   'online',
        note:   'Sent ' + amtNum + ' XLM · ' + txHash.substring(0,10) + '…',
        ts:     Date.now(),
        icon:   '⭐'
      });

      setTimeout(refreshFreighterBalance, 3000);
      setTimeout(fetchLiveXLMBalance, 4000);

    } else {
      var errCode = '';
      if (submitData.extras && submitData.extras.result_codes) {
        errCode = JSON.stringify(submitData.extras.result_codes);
      }
      renderXLMTxResult(false, '', amtNum, dest, errCode || submitData.title || 'Transaction was not accepted by the network');
    }

  } catch (e) {
    showLoading(false);
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Send XLM'; }
    var errMsg = e.message || String(e);
    if (/declin|reject|cancel|denied/i.test(errMsg)) {
      showAlert('orange', '⚠️ Transaction cancelled — rejected in Freighter');
      if (resultEl) resultEl.style.display = 'none';
    } else {
      renderXLMTxResult(false, '', 0, dest, errMsg.substring(0, 160));
    }
  }
}

function renderXLMTxResult(success, hash, amount, dest, errorMsg) {
  var resultEl = document.getElementById('xlmTxResult');
  var iconEl   = document.getElementById('xlmResultIcon');
  var titleEl  = document.getElementById('xlmResultTitle');
  var hashEl   = document.getElementById('xlmResultHash');
  var errorEl  = document.getElementById('xlmResultError');
  if (!resultEl) return;

  resultEl.style.display = 'block';

  if (success) {
    var safeHash = /^[A-Fa-f0-9]{16,128}$/.test(String(hash || '')) ? String(hash) : '';
    resultEl.style.background   = 'linear-gradient(135deg,#D4F7EC,#C6F9E8)';
    resultEl.style.borderColor  = 'rgba(46,213,115,0.4)';
    if (iconEl)  iconEl.textContent  = '✅';
    if (titleEl) { titleEl.textContent = 'Transaction Successful!'; titleEl.style.color = 'var(--success)'; }
    if (hashEl) {
      hashEl.style.display = 'block';
      hashEl.innerHTML =
        '<div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px;">Transaction Hash</div>' +
        '<div style="font-family:Courier New,monospace;font-size:10px;color:var(--primary);line-height:1.7;">' + safeText(safeHash || 'Unavailable') + '</div>' +
        (safeHash ? '<a class="xlm-explorer-link" href="https://stellar.expert/explorer/testnet/tx/' + encodeURIComponent(safeHash) + '" target="_blank" rel="noopener noreferrer">🔍 View on Stellar Expert →</a>' : '');
    }
    if (errorEl) errorEl.style.display = 'none';
    showAlert('success', '✅ ' + amount + ' XLM sent on Testnet!');

  } else {
    resultEl.style.background  = 'linear-gradient(135deg,#FFE0E3,#FFDDE0)';
    resultEl.style.borderColor = 'rgba(255,71,87,0.4)';
    if (iconEl)  iconEl.textContent = '❌';
    if (titleEl) { titleEl.textContent = 'Transaction Failed'; titleEl.style.color = 'var(--danger)'; }
    if (hashEl)  hashEl.style.display = 'none';
    if (errorEl) { errorEl.style.display = 'block'; errorEl.textContent = errorMsg || 'Unknown error occurred'; }
    showAlert('red', '❌ XLM transaction failed. See details below.');
  }

  setTimeout(function() {
    if (resultEl) resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

async function autoCheckFreighter() {
  var api = getFreighterAPI();
  if (!api) return;
  try {
    var connected = false;
    if (typeof api.isConnected === 'function') {
      var res = await api.isConnected();
      connected = (res === true) || (res && res.isConnected === true);
    }
    if (connected) {
      var publicKey;
      if (typeof api.getPublicKey === 'function') {
        publicKey = await api.getPublicKey();
      }
      if (publicKey) {
        FREIGHTER.isConnected = true;
        FREIGHTER.publicKey   = publicKey;
        await refreshFreighterBalance();
        updateFreighterUI();
      }
    }
  } catch (e) {  }
}

document.querySelectorAll('.modal-overlay').forEach(function(o){
  o.addEventListener('click', function(e){ if (e.target === o) o.classList.remove('show'); });
});

var _camStream = null;
var _camFrame  = null;

function toggleCamera() {
  if (_camStream) { stopCamera(); }
  else            { startCamera(); }
}

function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showAlert('red','❌ Camera not supported on this browser/device');
    return;
  }
  var btn = document.getElementById('cameraStartBtn');
  if (btn) btn.textContent = '⏳ Opening camera…';
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    .then(function(stream) {
      _camStream = stream;
      var video = document.getElementById('scanVideo');
      var wrap  = document.getElementById('scanVideoWrap');
      var ph    = document.getElementById('scanPlaceholder');
      video.srcObject = stream;
      video.play();
      if (wrap) wrap.style.display = 'block';
      if (ph)   ph.style.display   = 'none';
      if (btn)  btn.textContent    = '⏹ Stop Camera';
      _scanLoop();
    })
    .catch(function(err) {
      var btn2 = document.getElementById('cameraStartBtn');
      if (btn2) btn2.textContent = '📷 Open Camera';
      if (err.name === 'NotAllowedError') {
        showAlert('red','❌ Camera permission denied. Allow camera access and try again.');
      } else {
        showAlert('red','❌ Camera error: ' + err.message);
      }
    });
}

var _scanThrottle = 0; // only decode every N ms to save CPU

function _scanLoop() {
  var video  = document.getElementById('scanVideo');
  var canvas = document.getElementById('scanCanvas');
  var status = document.getElementById('scanStatus');
  if (!video || !canvas || !_camStream) return;

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    var now = Date.now();
    if (now - _scanThrottle >= 66) {
      _scanThrottle = now;

      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width  = video.videoWidth  || 640;
        canvas.height = video.videoHeight || 480;
      }

      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      if (typeof jsQR !== 'undefined') {
        var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = jsQR(imgData.data, imgData.width, imgData.height,
                        { inversionAttempts: 'attemptBoth' });
        if (code && code.data) {
          stopCamera();
          handleQRResult(code.data);
          return;
        }
        if (status) status.textContent = 'Scanning… Hold steady over the QR code';
      } else {
        if (status) status.textContent = '⏳ Loading QR decoder…';
      }
    }
  }

  _camFrame = requestAnimationFrame(_scanLoop);
}

function stopCamera() {
  if (_camStream) {
    _camStream.getTracks().forEach(function(t){ t.stop(); });
    _camStream = null;
  }
  if (_camFrame)  { cancelAnimationFrame(_camFrame); _camFrame = null; }
  var video = document.getElementById('scanVideo');
  var wrap  = document.getElementById('scanVideoWrap');
  var ph    = document.getElementById('scanPlaceholder');
  var btn   = document.getElementById('cameraStartBtn');
  if (video) video.srcObject = null;
  if (wrap)  wrap.style.display  = 'none';
  if (ph)    ph.style.display    = 'flex';
  if (btn)   btn.textContent     = '📷 Open Camera';
}

function handleQRResult(data) {
  var address = null, amount = null, label = null, equiv = null;

  if (data.startsWith('omnipay:')) {
    var raw = data.slice(8); // "GADDR?amount=10..."
    var qIdx = raw.indexOf('?');
    if (qIdx !== -1) {
      address = raw.slice(0, qIdx);
      var qs  = raw.slice(qIdx + 1);
      qs.split('&').forEach(function(pair) {
        var parts = pair.split('=');
        var k = parts[0];
        var v = decodeURIComponent(parts.slice(1).join('='));
        if (k === 'amount') amount = parseFloat(v);
        if (k === 'label')  label  = v;
        if (k === 'equiv')  equiv  = v;
      });
    } else {
      address = raw;
    }
  } else if (isValidStellarPublicKey(data)) {
    address = normalizeStellarPublicKey(data);
  }

  if (address) address = normalizeStellarPublicKey(address);
  if (address && isValidStellarPublicKey(address)) {
    switchPayTab('send', document.querySelector('.pay-tab:nth-child(2)'));
    setTimeout(function() {
      var rEl = document.getElementById('sendRecipient');
      var aEl = document.getElementById('sendAmount');
      var nEl = document.getElementById('sendNote');
      if (rEl) { rEl.value = address; rEl.style.borderColor = 'var(--success)'; }
      if (aEl && amount) {
        aEl.value = amount.toFixed(7);
        aEl.style.borderColor = 'var(--success)';
        updateXlmConversion();
      }
      if (nEl && label) nEl.value = 'Payment to ' + label;

      var msg = '✅ QR scanned!';
      if (label)  msg += ' Paying ' + label;
      if (amount) msg += ' · ' + amount.toFixed(4) + ' XLM';
      if (equiv)  msg += ' (≈ ' + equiv + ')';
      showAlert('success', msg);
    }, 120);
  } else {
    simulateScan();
  }
}

var XLM_RATES = {
  AUD:{ symbol:'A$',   rate:0.29   }, BDT:{ symbol:'৳',   rate:20.9  },
  BHD:{ symbol:'BD',   rate:0.071  }, BRL:{ symbol:'R$',  rate:0.98  },
  CAD:{ symbol:'C$',   rate:0.26   }, CNY:{ symbol:'¥',   rate:1.38  },
  EGP:{ symbol:'E£',   rate:6.17   }, EUR:{ symbol:'€',   rate:0.174 },
  GBP:{ symbol:'£',    rate:0.149  }, GHS:{ symbol:'GH₵', rate:2.72  },
  INR:{ symbol:'₹',    rate:15.83  }, IDR:{ symbol:'Rp',  rate:3040  },
  IRR:{ symbol:'﷼',   rate:8073   }, IQD:{ symbol:'IQD', rate:249   },
  ILS:{ symbol:'₪',    rate:0.697  }, JPY:{ symbol:'¥',   rate:29.3  },
  JOD:{ symbol:'JD',   rate:0.135  }, KZT:{ symbol:'₸',   rate:87    },
  KES:{ symbol:'KSh',  rate:24.5   }, KWD:{ symbol:'KD',  rate:0.0586},
  MYR:{ symbol:'RM',   rate:0.894  }, MXN:{ symbol:'MX$', rate:3.17  },
  NGN:{ symbol:'₦',    rate:309    }, NOK:{ symbol:'kr',  rate:2.03  },
  OMR:{ symbol:'RO',   rate:0.073  }, PKR:{ symbol:'₨',   rate:52.2  },
  PHP:{ symbol:'₱',    rate:11.58  }, QAR:{ symbol:'QR',  rate:0.692 },
  RUB:{ symbol:'₽',    rate:17.4   }, SAR:{ symbol:'SR',  rate:0.712 },
  SGD:{ symbol:'S$',   rate:0.256  }, SOS:{ symbol:'Sh',  rate:108   },
  ZAR:{ symbol:'R',    rate:3.48   }, KRW:{ symbol:'₩',   rate:253   },
  LKR:{ symbol:'₨',    rate:58.6   }, SEK:{ symbol:'kr',  rate:2.06  },
  CHF:{ symbol:'CHF',  rate:0.169  }, TWD:{ symbol:'NT$', rate:6.02  },
  TZS:{ symbol:'TSh',  rate:491    }, THB:{ symbol:'฿',   rate:6.81  },
  TND:{ symbol:'DT',   rate:0.598  }, TRY:{ symbol:'₺',   rate:6.17  },
  AED:{ symbol:'AED',  rate:0.697  }, USD:{ symbol:'$',   rate:0.19  },
  VND:{ symbol:'₫',    rate:4830   }, YER:{ symbol:'YR',  rate:47.5  }
};
var COUNTRY_TO_CUR = {
  'Australia':'AUD','Bahrain':'BHD','Bangladesh':'BDT','Brazil':'BRL',
  'Canada':'CAD','China':'CNY','Egypt':'EGP','France':'EUR','Germany':'EUR',
  'Ghana':'GHS','India':'INR','Indonesia':'IDR','Iran':'IRR','Iraq':'IQD',
  'Israel':'ILS','Italy':'EUR','Japan':'JPY','Jordan':'JOD','Kazakhstan':'KZT',
  'Kenya':'KES','Kuwait':'KWD','Malaysia':'MYR','Mexico':'MXN','Nigeria':'NGN',
  'Norway':'NOK','Oman':'OMR','Pakistan':'PKR','Philippines':'PHP','Qatar':'QAR',
  'Russia':'RUB','Saudi Arabia':'SAR','Singapore':'SGD','Somalia':'SOS',
  'South Africa':'ZAR','South Korea':'KRW','Spain':'EUR','Sri Lanka':'LKR',
  'Sweden':'SEK','Switzerland':'CHF','Taiwan':'TWD','Tanzania':'TZS',
  'Thailand':'THB','Tunisia':'TND','Turkey':'TRY','UAE':'AED',
  'United Kingdom':'GBP','United States':'USD','Vietnam':'VND','Yemen':'YER'
};

function getUserCurrency() {
  var country = (STATE.user && STATE.user.country) ? STATE.user.country : '';
  var name    = country.replace(/^\S+\s*/, '').trim();  // strip flag emoji
  var code    = COUNTRY_TO_CUR[name] || 'USD';
  return XLM_RATES[code] || XLM_RATES['USD'];
}

var _SEND_CONV_CACHE_MS = 25000;
var _sendConvCache   = { cur: null, rate: null, ts: 0 };
var _sendConvTimer   = null;
var _sendConvToken   = 0;
var _sendConvPollId  = null;

function _startSendConvAutoRefresh() {
  _stopSendConvAutoRefresh();
  _sendConvPollId = setInterval(function () {
    var amt = parseFloat((document.getElementById('sendAmount') || {}).value) || 0;
    if (amt > 0) { _renderLiveSendConversion(); }
  }, _SEND_CONV_CACHE_MS);
}

function _stopSendConvAutoRefresh() {
  if (_sendConvPollId) { clearInterval(_sendConvPollId); _sendConvPollId = null; }
}

function updateXlmConversion() {
  var el  = document.getElementById('xlmConversionDisplay');
  if (!el) return;
  var amt = parseFloat(document.getElementById('sendAmount').value) || 0;
  if (!amt || amt <= 0) { el.textContent = ''; return; }

  el.innerHTML = '<span style="opacity:0.6;">Loading rate…</span>';

  clearTimeout(_sendConvTimer);
  _sendConvTimer = setTimeout(function(){ _renderLiveSendConversion(); }, 350);
}

async function _renderLiveSendConversion() {
  var el = document.getElementById('xlmConversionDisplay');
  if (!el) return;
  var myToken = ++_sendConvToken;

  var cfg      = _getCountryConfig(STATE.user && STATE.user.country); // { coin, sym, cur }
  var fallback = XLM_RATES[cfg.cur.toUpperCase()] || getUserCurrency(); // static last-resort rate
  var now      = Date.now();
  var rate     = null;

  if (_sendConvCache.cur === cfg.cur && (now - _sendConvCache.ts) < _SEND_CONV_CACHE_MS) {
    rate = _sendConvCache.rate;
  } else {
    try {
      var rc = new AbortController();
      var rt = setTimeout(function(){ rc.abort(); }, 6000);
      var resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=' + cfg.cur, { signal: rc.signal });
      clearTimeout(rt);
      if (resp.ok) {
        var data = await resp.json();
        rate = (data.stellar && data.stellar[cfg.cur]) ? parseFloat(data.stellar[cfg.cur]) : null;
      }
    } catch(_e) {}
    if (rate === null) {
      try {
        var rc2  = new AbortController();
        var rt2  = setTimeout(function(){ rc2.abort(); }, 6000);
        var cur2 = cfg.cur.toUpperCase();
        var resp2 = await fetch('https://min-api.cryptocompare.com/data/price?fsym=XLM&tsyms=' + cur2, { signal: rc2.signal });
        clearTimeout(rt2);
        if (resp2.ok) {
          var data2 = await resp2.json();
          rate = data2[cur2] ? parseFloat(data2[cur2]) : null;
        }
      } catch(_e2) {}
    }
    if (rate !== null) { _sendConvCache = { cur: cfg.cur, rate: rate, ts: now }; }
  }

  if (myToken !== _sendConvToken) return; // a newer request superseded this one

  var liveAmt = parseFloat(document.getElementById('sendAmount').value) || 0;
  if (!liveAmt || liveAmt <= 0) { el.textContent = ''; return; }

  var usedFallback = false;
  if (rate === null) { rate = fallback.rate; usedFallback = true; }

  var total     = liveAmt * rate;
  var formatted = total >= 1000 ? total.toLocaleString('en',{maximumFractionDigits:2}) : total.toFixed(2);
  var tag       = usedFallback ? 'approx., offline' : 'estimated';
  el.innerHTML = '<span style="color:var(--success);">≈ ' + cfg.sym + formatted + '</span> <span style="opacity:0.6;font-size:11px;">(' + tag + ')</span>';
}

function nextRegStep() {
  var first  = document.getElementById('regFirst').value.trim();
  var last   = document.getElementById('regLast').value.trim();
  var phone  = document.getElementById('regPhone').value.trim();
  var email  = document.getElementById('regEmail').value.trim();

  var ok = true;
  if (!first)  { document.getElementById('regFirst').classList.add('error'); ok = false; }
  if (!last)   { document.getElementById('regLast').classList.add('error');  ok = false; }
  if (!phone)  { document.getElementById('regPhone').classList.add('error'); ok = false; }
  if (!email || !email.includes('@')) { document.getElementById('regEmail').classList.add('error'); ok = false; }
  if (!ok) { showAlert('red','⚠️ Please fill in all Personal Information fields correctly'); return; }

  document.getElementById('regStep1').style.display = 'none';
  document.getElementById('regStep2').style.display = 'block';

  var dot2 = document.getElementById('regDot2');
  var line  = document.getElementById('regLine');
  if (dot2) { dot2.style.background = 'var(--primary)'; dot2.style.color = '#fff'; }
  if (line) line.style.width = '100%';
}

function prevRegStep() {
  document.getElementById('regStep2').style.display = 'none';
  document.getElementById('regStep1').style.display = 'block';

  var dot2 = document.getElementById('regDot2');
  var line  = document.getElementById('regLine');
  if (dot2) { dot2.style.background = 'var(--border)'; dot2.style.color = 'var(--text-muted)'; }
  if (line) line.style.width = '0%';
}

function saveSession() {
  try {
    var walletSession = {
      publicKey:       STATE.wallet && STATE.wallet.publicKey || '',
      xlmBalance:      STATE.wallet && STATE.wallet.xlmBalance || 0,
      contractAddress: STATE.wallet && STATE.wallet.contractAddress || ''
    };
    var data = {
      isLoggedIn:         STATE.isLoggedIn,
      uid:                STATE.uid,
      user:               STATE.user,
      balance:            STATE.balance,
      vaultLocked:        STATE.vaultLocked,
      vaultUsesTotal:     STATE.vaultUsesTotal,
      vaultUsesRemaining: STATE.vaultUsesRemaining,
      trustScore:         STATE.trustScore,
      monoCounter:        STATE.monoCounter,
      goodTxCount:        STATE.goodTxCount,
      memberSince:        STATE.memberSince,
      wallet:             walletSession,
      wallets:            STATE.wallets,
      activeWalletIndex:  STATE.activeWalletIndex,
      transactions:       dedupeTransactions(STATE.transactions),
      noncePool:          STATE.noncePool,
      usedNonces:         STATE.usedNonces
    };
    sessionStorage.setItem('omnipay_session', JSON.stringify(data));
  } catch(e) {}
}

function restoreSession() {
  try {
    var raw = sessionStorage.getItem('omnipay_session');
    if (!raw) return false;
    var d = JSON.parse(raw);
    if (!d || !d.isLoggedIn || !auth || !auth.currentUser || d.uid !== auth.currentUser.uid) {
      sessionStorage.removeItem('omnipay_session');
      return false;
    }
    STATE.isLoggedIn         = true;
    STATE.uid                = d.uid                || null;
    STATE.user               = d.user               || STATE.user;
    STATE.balance            = d.balance            != null ? d.balance : 2500;
    STATE.vaultLocked        = d.vaultLocked        != null ? d.vaultLocked : 0;
    STATE.vaultUsesTotal     = d.vaultUsesTotal     || 1;
    STATE.vaultUsesRemaining = d.vaultUsesRemaining || 1;
    STATE.trustScore         = d.trustScore         != null ? d.trustScore : 5;
    STATE.monoCounter        = d.monoCounter        || 0;
    STATE.goodTxCount        = d.goodTxCount        || 0;
    STATE.memberSince        = d.memberSince        || '';
    STATE.wallet             = d.wallet             || STATE.wallet;
    STATE.wallet.secretKey   = '';
    STATE.wallets            = Array.isArray(d.wallets)       ? d.wallets       : [];
    STATE.activeWalletIndex  = d.activeWalletIndex  != null   ? d.activeWalletIndex : 0;
    STATE.transactions       = dedupeTransactions(d.transactions);
    STATE.noncePool          = Array.isArray(d.noncePool)    ? d.noncePool    : [1,2,3,4,5,6,7,8,9,10];
    STATE.usedNonces         = Array.isArray(d.usedNonces)   ? d.usedNonces   : [];
    setTimeout(startInboxListener, 0);
    return true;
  } catch(e) { return false; }
}

function quickSend() {
  navTo('pay');
  setTimeout(function(){
    var tabs = document.querySelectorAll('.pay-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].textContent.trim().indexOf('Send') !== -1) {
        switchPayTab('send', tabs[i]);
        break;
      }
    }
  }, 60);
}

function simulateReceive() {
  var senders = ['Maria Santos', 'Jose Reyes', 'Ana Cruz', 'Pedro Lopez', 'Liza Tan'];
  var sender  = senders[Math.floor(Math.random() * senders.length)];
  var amt     = Math.floor(Math.random() * 500) + 50;
  STATE.balance += amt;
  STATE.transactions.unshift({
    id: 'rx-' + Date.now(),
    type: 'receive',
    name: sender,
    amount: amt,
    status: 'synced',
    mode: 'online',
    note: 'Received from ' + sender,
    ts: Date.now(),
    icon: '📲'
  });
  saveSession();
  closeModal('receiveModal');
  showAlert('success', '💰 Received ₱' + amt.toFixed(2) + ' from ' + sender + '!');
  renderHome();
  renderHistory('all');
}

function showWalletManagerModal() {
  if (!STATE.isLoggedIn) { showAlert('orange','⚠️ Please log in first'); return; }
  renderWalletList();
  showModal('walletManagerModal');
}

async function fetchWalletBalance(publicKey) {
  try {
    var r = await fetch('https://horizon-testnet.stellar.org/accounts/' + publicKey);
    if (!r.ok) return null;
    var d = await r.json();
    var native = (d.balances || []).find(function(b){ return b.asset_type === 'native'; });
    return native ? parseFloat(native.balance) : 0;
  } catch(e) { return null; }
}

function renderWalletList() {
  var container = document.getElementById('walletListContainer');
  if (!container) return;
  if (!STATE.wallets || STATE.wallets.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">No wallets saved yet.</div>';
    return;
  }
  container.innerHTML = STATE.wallets.map(function(w, i) {
    var isActive = i === STATE.activeWalletIndex;
    var shortKey = w.publicKey ? (w.publicKey.substring(0,8) + '…' + w.publicKey.slice(-6)) : 'Unknown';
    var balText  = w.xlmBalance != null ? parseFloat(w.xlmBalance).toLocaleString('en',{minimumFractionDigits:4}) + ' XLM' : '— XLM';
    return '<div class="wallet-item'+(isActive?' active':'')+'">'
      + '<div class="wallet-item-top">'
      + '<div class="wallet-item-label">'+safeText(w.label||'Wallet '+(i+1))+'</div>'
      + (isActive
          ? '<span class="wallet-item-badge">✓ Active</span>'
          : '<button class="wallet-setactive-btn" onclick="setActiveWallet('+i+')">Set Active</button>')
      + '</div>'
      + '<div class="wallet-item-key">'+safeText(shortKey)+'</div>'
      + '<div class="wallet-item-bottom">'
      + '<div class="wallet-item-balance">'+safeText(balText)+'</div>'
      + '<div class="wallet-item-actions">'
      + '<button class="wallet-action-btn" onclick="refreshWalletBalance('+i+')">🔄 Refresh</button>'
      + (i > 0 ? '<button class="wallet-action-btn danger" onclick="removeWallet('+i+')">🗑 Remove</button>' : '')
      + '</div></div>'
      + '<a class="wallet-item-explorer" href="https://stellar.expert/explorer/testnet/account/'+encodeURIComponent(String(w.publicKey||''))+'" target="_blank" rel="noopener noreferrer">⭐ View on Stellar Expert ›</a>'
      + '</div>';
  }).join('');
}

function setActiveWallet(idx) {
  if (idx < 0 || idx >= STATE.wallets.length) return;
  STATE.activeWalletIndex = idx;
  var w = STATE.wallets[idx];
  STATE.wallet.publicKey  = w.publicKey;
  STATE.wallet.xlmBalance = w.xlmBalance || STATE.wallet.xlmBalance;
  syncSpendableBalance();
  var heroEl = document.getElementById('heroBalance');
  if (heroEl) heroEl.textContent = STATE.wallet.xlmBalance.toLocaleString('en',{minimumFractionDigits:4,maximumFractionDigits:4});
  saveSession();
  renderWalletList();
  showAlert('success','✅ Active wallet switched to: ' + (w.label || 'Wallet '+(idx+1)));
}

async function refreshWalletBalance(idx) {
  var w = STATE.wallets[idx];
  if (!w || !w.publicKey) return;
  var bal = await fetchWalletBalance(w.publicKey);
  if (bal !== null) {
    STATE.wallets[idx].xlmBalance = bal;
    if (idx === STATE.activeWalletIndex) { STATE.wallet.xlmBalance = bal; syncSpendableBalance(); }
    saveSession();
    renderWalletList();
    showAlert('success', '🔄 Balance refreshed: ' + bal.toFixed(4) + ' XLM');
  } else {
    showAlert('orange', '⚠️ Could not fetch balance — check your connection');
  }
}

function removeWallet(idx) {
  if (idx === 0) { showAlert('red','❌ Cannot remove the primary wallet'); return; }
  var label = STATE.wallets[idx].label || ('Wallet ' + (idx + 1));
  STATE.wallets.splice(idx, 1);
  if (STATE.activeWalletIndex >= STATE.wallets.length) {
    STATE.activeWalletIndex = 0;
    STATE.wallet.publicKey  = STATE.wallets[0].publicKey;
    STATE.wallet.xlmBalance = STATE.wallets[0].xlmBalance || STATE.wallet.xlmBalance;
    syncSpendableBalance();
  }
  saveSession();
  renderWalletList();
  showAlert('success','🗑 ' + label + ' removed');
}

async function addNewWallet() {
  var addressInput = document.getElementById('newWalletAddress');
  var labelInput   = document.getElementById('newWalletLabel');
  var address = (addressInput.value || '').trim();
  var label   = (labelInput.value || '').trim() || ('Wallet ' + (STATE.wallets.length + 1));

  if (!address) { addressInput.classList.add('error'); showAlert('red','⚠️ Enter a Stellar public key'); return; }
  address = normalizeStellarPublicKey(address);
  addressInput.value = address;
  if (!isValidStellarPublicKey(address)) { addressInput.classList.add('error'); showAlert('red','❌ ' + stellarAddressError(address)); return; }

  var dup = STATE.wallets.find(function(w){ return w.publicKey === address; });
  if (dup) { addressInput.classList.add('error'); showAlert('orange','⚠️ This wallet address is already in your list'); return; }

  var btn = document.getElementById('addWalletBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking…'; }

  var bal = await fetchWalletBalance(address);

  STATE.wallets.push({
    publicKey:  address,
    label:      label,
    xlmBalance: bal !== null ? bal : 0,
    addedAt:    Date.now()
  });

  addressInput.value = '';
  labelInput.value   = '';
  saveSession();
  renderWalletList();

  if (btn) { btn.disabled = false; btn.textContent = '⭐ Add Wallet'; }
  showAlert('success', '✅ Wallet added! Balance: ' + (bal !== null ? bal.toFixed(4) + ' XLM' : '0 XLM (not funded on testnet)'));
}

document.getElementById('loginPass').addEventListener('keydown', function(e){ if (e.key==='Enter') doLogin(); });
document.getElementById('loginUser').addEventListener('keydown', function(e){ if (e.key==='Enter') document.getElementById('loginPass').focus(); });

var SESSION_RESTORED = false;

window.addEventListener('DOMContentLoaded', function(){
  initTheme();
  updateFreighterUI();
  if (db) {
    setFbStatus('connected','🟢 Firebase connected');
  } else {
    setFbStatus('error','⚠️ Firebase offline');
  }
  setTimeout(autoCheckFreighter, 800);
  if (restoreSession()) {
    SESSION_RESTORED = true;
    document.getElementById('bottomNav').style.display = 'flex';
    renderHome();
    navTo('home');
  } else {
    renderHome();
  }

  if (auth) {
    auth.onAuthStateChanged(function(user) {
      if (!user || STATE.isLoggedIn) return;
      if (restoreSession()) {
        SESSION_RESTORED = true;
        document.getElementById('bottomNav').style.display = 'flex';
        renderHome();
        navTo('home');
      }
    });
  }
});

setTimeout(function(){
  if (!SESSION_RESTORED) { goTo('login'); }
}, 3600);

/* OmniCard authentication prototype */
var OMNICARD_STATE = {
  status: 'not-paired',
  cardId: '',
  publicKey: '',
  lastAuth: '',
  nonce: '',
  signature: '',
  verified: false
};

function getOmniCardState() {
  if (OMNICARD_STATE.status === 'ready') return { label: 'Ready', helper: 'Your card is ready to authenticate a payment.', className: 'ready' };
  if (OMNICARD_STATE.status === 'paired') return { label: 'Paired', helper: 'Card paired successfully. Run the demo when ready.', className: 'paired' };
  return { label: 'Not paired', helper: 'Pair an OmniCard to enable authentication.', className: 'not-paired' };
}

function setOmniCardText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

function shortOmniValue(value, start, end) {
  var text = String(value || '');
  return text.length > (start + end + 1) ? text.slice(0, start) + '…' + text.slice(-end) : text;
}

function randomOmniHex(length) {
  var output = '';
  var bytes = new Uint8Array(Math.ceil(length / 2));
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (var j = 0; j < bytes.length; j++) output += bytes[j].toString(16).padStart(2, '0');
  return output.slice(0, length).toUpperCase();
}

function updateOmniCardUI() {
  var state = getOmniCardState();
  var card = document.getElementById('omniCardStatusCard');
  if (card) card.setAttribute('data-status', state.className);
  setOmniCardText('omniCardStatus', state.label);
  setOmniCardText('omniCardStatusLabel', state.label);
  setOmniCardText('omniCardStatusHelper', state.helper);
  setOmniCardText('homeOmniCardStatus', state.label);
  setOmniCardText('omniCardId', OMNICARD_STATE.cardId ? OMNICARD_STATE.cardId : '—');
  setOmniCardText('omniCardPublicKey', OMNICARD_STATE.publicKey ? shortOmniValue(OMNICARD_STATE.publicKey, 10, 8) : '—');
  setOmniCardText('omniCardLastAuth', OMNICARD_STATE.lastAuth || 'No authentication yet');
  setOmniCardText('omniCardNonce', OMNICARD_STATE.nonce || '—');
  setOmniCardText('omniCardVerification', OMNICARD_STATE.verified ? 'Verified' : 'Pending');
  setOmniCardText('omniChallengePreview', OMNICARD_STATE.cardId ? 'OMNI-' + OMNICARD_STATE.cardId.slice(-6) + ' · payment challenge' : 'Pair your card to generate a challenge');

  var verification = document.getElementById('omniCardVerification');
  if (verification) verification.className = OMNICARD_STATE.verified ? 'verification-success' : 'verification-pending';
  var result = document.getElementById('omniVerificationResult');
  if (result) result.setAttribute('data-state', OMNICARD_STATE.verified ? 'success' : 'pending');
  var pairButton = document.getElementById('pairOmniCardBtn');
  if (pairButton) {
    pairButton.textContent = state.className === 'not-paired' ? 'Pair OmniCard' : 'Reset pairing';
    pairButton.className = state.className === 'ready' ? 'btn btn-outline btn-block' : 'btn btn-primary btn-block';
  }
  var authenticateButton = document.getElementById('authenticatePaymentBtn');
  if (authenticateButton) authenticateButton.disabled = state.className === 'not-paired';
  var copyButton = document.getElementById('copyOmniCardKeyBtn');
  if (copyButton) copyButton.disabled = !OMNICARD_STATE.publicKey;
}

function pairOmniCard() {
  if (OMNICARD_STATE.status !== 'not-paired') {
    OMNICARD_STATE = { status: 'not-paired', cardId: '', publicKey: '', lastAuth: '', nonce: '', signature: '', verified: false };
    updateOmniCardUI();
    showAlert('yellow', 'OmniCard pairing reset.');
    return;
  }

  var button = document.getElementById('pairOmniCardBtn');
  if (button) { button.disabled = true; button.textContent = 'Pairing OmniCard…'; }
  var card = document.getElementById('omniCardStatusCard');
  if (card) card.setAttribute('data-status', 'pairing');

  setTimeout(function() {
    OMNICARD_STATE.status = 'paired';
    OMNICARD_STATE.cardId = 'OC-' + randomOmniHex(8);
    OMNICARD_STATE.publicKey = 'pk_omnicard_' + randomOmniHex(40).toLowerCase();
    OMNICARD_STATE.verified = false;
    updateOmniCardUI();
    showAlert('success', 'OmniCard paired successfully.');
  }, 850);
}

async function createOmniSignature(payload) {
  var input = String(payload);
  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    var digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest)).map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }
  return randomOmniHex(32);
}

async function authenticateOmniCardPayment() {
  if (OMNICARD_STATE.status === 'not-paired') {
    showAlert('orange', 'Pair your OmniCard first.');
    return;
  }
  var merchant = (document.getElementById('omniMerchant').value || '').trim() || 'Omni Market';
  var amount = parseFloat(document.getElementById('omniAmount').value);
  if (!isFinite(amount) || amount <= 0) {
    showAlert('orange', 'Enter a valid payment amount.');
    return;
  }

  var button = document.getElementById('authenticatePaymentBtn');
  var result = document.getElementById('omniVerificationResult');
  if (button) { button.disabled = true; button.textContent = 'Verifying challenge…'; }
  if (result) result.setAttribute('data-state', 'checking');
  setOmniCardText('omniVerificationText', 'Checking nonce and signature…');
  OMNICARD_STATE.status = 'paired';
  updateOmniCardUI();

  var nonce = 'N-' + Date.now().toString(36).toUpperCase() + '-' + randomOmniHex(4);
  var signature = await createOmniSignature([OMNICARD_STATE.cardId, merchant, amount.toFixed(2), nonce].join('|'));
  OMNICARD_STATE.nonce = nonce;
  OMNICARD_STATE.signature = signature;
  OMNICARD_STATE.lastAuth = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  OMNICARD_STATE.verified = true;
  OMNICARD_STATE.status = 'ready';
  updateOmniCardUI();
  setOmniCardText('omniVerificationText', 'Payment challenge verified for ' + merchant + ' · ₱' + amount.toFixed(2));
  var resultIcon = document.querySelector('.verification-result-icon');
  if (resultIcon) resultIcon.textContent = '✓';
  if (button) { button.disabled = false; button.textContent = 'Authenticate payment'; }
  showAlert('success', 'Payment authenticated. Nonce and signature verified.');
}

function copyOmniCardKey() {
  if (!OMNICARD_STATE.publicKey) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(OMNICARD_STATE.publicKey).then(function() {
      showAlert('success', 'Public key copied.');
    }).catch(function() {
      showAlert('yellow', 'Copy the public key manually.');
    });
  }
}

function showOmniLinkDetails() {
  showAlert('yellow', 'OmniLink connects the card device, merchant challenge, and verification service.');
}

function renderVault() {
  updateOmniCardUI();
}