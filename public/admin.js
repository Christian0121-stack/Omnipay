(function () {
  'use strict';

  var KEY_STORE = 'omnipay_admin_key';
  var POLL_MS = 5000;
  var EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/';
  var CHANNELS = { sms: 'SMS', api: 'Signed API', web: 'App' };
  var STAGES = [
    { key: 'received', label: 'Received' },
    { key: 'validated', label: 'Validated' },
    { key: 'submitted', label: 'Submitted' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'settled', label: 'Settled' }
  ];
  var REASONS = {
    'insufficient-balance': 'Insufficient balance',
    'self-send': 'Cannot send to yourself',
    'recipient-not-found': 'Recipient not found',
    'incorrect-pin': 'Incorrect PIN',
    'pin-locked': 'Too many wrong PIN attempts',
    'signature-required': 'Signature required',
    'no-registered-signing-key': 'No signing key registered',
    'duplicate-request': 'Duplicate request',
    'nonce-reused': 'Nonce already used',
    'unknown-sender': 'Unknown sender',
    'wallet-not-setup': 'Wallet not set up',
    'malformed-command': 'Malformed command',
    'malformed-transaction': 'Malformed transaction',
    'sender-not-found': 'Sender not found',
    'settlement-signer-not-enabled': 'SMS settlement not enabled for this wallet',
    'settlement-signer-not-configured': 'Settlement unavailable'
  };

  var state = {
    key: '',
    rows: [],
    seen: null,
    fresh: {},
    filter: 'all',
    channel: '',
    range: 'all',
    from: '',
    to: '',
    query: '',
    open: {},
    audits: {},
    streamAbort: null,
    streamLive: false,
    retryId: null,
    pollId: null,
    loading: false,
    users: [],
    usersLoaded: false,
    usersLoading: false,
    userQuery: '',
    activeUser: null,
    activeAuth: null,
    defaultPassword: '123456',
    defaultPin: '123456',
    resetConfirm: false,
    resetBusy: false,
    resetMsg: null,
    pinConfirm: false,
    pinBusy: false,
    pinMsg: null,
    walletConfirm: false,
    walletBusy: false,
    walletMsg: null,
    editOpen: false,
    editBusy: false,
    editMsg: null,
    editPhone: '',
    editEmail: '',
    activePayments: null,
    payFilter: 'all',
    payShown: 10,
    umTab: 'profile',
    lookupQ: '',
    lookupBusy: false,
    lookupRes: null,
    uploads: [],
    uploadsLoaded: false,
    uploadsLoading: false,
    activeUpload: null,
    activeUploadUser: null,
    upQuery: '',
    upList: [],
    userDate: { range: 'all', from: '', to: '' },
    upDate: { range: 'all', from: '', to: '' }
  };

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    var seconds = value._seconds != null ? value._seconds : value.seconds;
    var nanos = value._nanoseconds != null ? value._nanoseconds : value.nanoseconds;
    return seconds != null ? seconds * 1000 + Math.floor((nanos || 0) / 1e6) : 0;
  }

  function fmtTime(ms) {
    return ms ? new Date(ms).toLocaleString() : '—';
  }

  function fmtAmount(n) {
    return Number(n || 0).toLocaleString('en', { minimumFractionDigits: 4, maximumFractionDigits: 7 });
  }

  function reasonText(detail) {
    var text = String(detail == null ? '' : detail).trim();
    if (!text) return '';
    if (REASONS[text]) return REASONS[text];
    if (text.indexOf('bad-signature') === 0) {
      var sub = text.split(':')[1];
      return 'Signature check failed' + (sub ? ' (' + sub + ')' : '');
    }
    if (text.indexOf('xdr-mismatch') === 0) return 'Signed transaction did not match the request';
    if (text.indexOf('soroban') === 0) return 'Contract settlement failed';
    return text.length > 120 ? text.slice(0, 120) + '…' : text;
  }

  function normalize(raw) {
    var history = Array.isArray(raw.statusHistory) ? raw.statusHistory : [];
    var payload = raw.signedPayload || {};
    var validation = raw.signatureValidation || null;
    var status = raw.status || 'received';
    var category = 'progress';
    if (status === 'settled') category = 'settled';
    else if (status === 'validation_failed') category = 'rejected';
    else if (status === 'failed') category = 'failed';

    var reason = '';
    if (category === 'rejected' || category === 'failed') {
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i].detail) { reason = history[i].detail; break; }
      }
      if (!reason && validation && validation.reason) reason = validation.reason;
    }

    var reached = {};
    history.forEach(function (h) { reached[h.status] = true; });
    reached[status] = true;
    var reachedIdx = -1;
    STAGES.forEach(function (s, i) { if (reached[s.key]) reachedIdx = i; });

    return {
      id: raw.id,
      channel: raw.channel || '',
      senderId: raw.senderId || '',
      senderPhone: raw.senderPhone || '',
      recipient: raw.recipient || '',
      senderUsername: raw.senderUsername || '',
      recipientUsername: raw.recipientUsername || '',
      amount: raw.amount != null ? Number(raw.amount) : null,
      status: status,
      category: category,
      history: history,
      validation: validation,
      reason: reason,
      reachedIdx: reachedIdx,
      txHash: raw.txHash || '',
      sorobanTxHash: raw.sorobanTxHash || '',
      requestId: payload.requestId || '',
      nonce: payload.nonce || '',
      createdAt: toMs(raw.createdAt)
    };
  }

  function senderLabel(r) {
    return r.senderUsername ? r.senderUsername : (r.senderId || r.senderPhone || 'Unknown sender');
  }

  function recipientLabel(r) {
    if (r.recipientUsername) return r.recipientUsername;
    return r.recipient || 'Unknown';
  }

  function statusLabel(r) {
    if (r.category === 'rejected') return 'Rejected';
    if (r.category === 'failed') return 'Failed';
    if (r.category === 'settled') return 'Settled';
    return r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : 'In progress';
  }

  function statusIcon(r) {
    if (r.category === 'settled') return '✓';
    if (r.category === 'rejected') return '✕';
    if (r.category === 'failed') return '!';
    return '⏳';
  }

  function setLive(mode, text) {
    var el = $('live');
    el.classList.toggle('on', mode === 'live');
    el.classList.toggle('poll', mode === 'poll');
    $('liveText').textContent = text;
  }

  function showGate(message) {
    closeUser();
    state.users = [];
    state.usersLoaded = false;
    state.uploads = [];
    state.uploadsLoaded = false;
    setView('relay');
    $('dash').classList.add('hidden');
    $('gate').classList.remove('hidden');
    $('gateMsg').textContent = message || '';
    stopLive();
    setLive('off', 'Not connected');
  }

  function showDash() {
    $('gate').classList.add('hidden');
    $('dash').classList.remove('hidden');
  }

  function applyRows(list) {
    var rows = (Array.isArray(list) ? list : []).map(normalize);
    rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (state.seen) {
      rows.forEach(function (r) {
        if (!state.seen[r.id]) state.fresh[r.id] = true;
      });
    }
    state.seen = state.seen || {};
    rows.forEach(function (r) { state.seen[r.id] = true; });
    state.rows = rows;
    showDash();
    render();
    state.fresh = {};
  }

  function failAuth(status) {
    try { sessionStorage.removeItem(KEY_STORE); } catch (e) {}
    state.key = '';
    if (status === 503) showGate('Admin endpoints are disabled. Set ADMIN_API_KEY on the server.');
    else showGate('Invalid admin key.');
  }

  function api(path) {
    return fetch(path, { headers: { 'x-admin-key': state.key } });
  }

  async function load() {
    if (state.loading || !state.key) return;
    state.loading = true;
    try {
      var resp = await api('/api/relay-transactions?limit=200');
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      if (!resp.ok) throw new Error('http-' + resp.status);
      var data = await resp.json();
      applyRows(data.transactions);
      if (!state.streamLive) setLive('poll', 'Polling · ' + new Date().toLocaleTimeString());
    } catch (e) {
      if (state.rows.length) setLive('off', 'Offline · retrying');
      else showGate('Could not reach the server.');
    } finally {
      state.loading = false;
    }
  }

  function streamSupported() {
    return typeof ReadableStream !== 'undefined' && typeof AbortController !== 'undefined' && typeof TextDecoder !== 'undefined';
  }

  function handleBlock(block) {
    block.split('\n').forEach(function (line) {
      if (line.indexOf('data:') !== 0) return;
      try {
        var payload = JSON.parse(line.slice(5).trim());
        applyRows(payload.transactions);
        setLive('live', 'Live · Firestore');
      } catch (e) {}
    });
  }

  async function startStream() {
    stopStream();
    if (!streamSupported() || !state.key || !$('auto').checked) return;
    var controller = new AbortController();
    state.streamAbort = controller;
    try {
      var resp = await fetch('/api/relay-transactions/stream', {
        headers: { 'x-admin-key': state.key, 'Accept': 'text/event-stream' },
        signal: controller.signal
      });
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      if (!resp.ok || !resp.body) throw new Error('http-' + resp.status);
      state.streamLive = true;
      setLive('live', 'Live · Firestore');
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        blocks.forEach(handleBlock);
      }
    } catch (e) {}
    if (state.streamAbort !== controller) return;
    state.streamAbort = null;
    state.streamLive = false;
    if (state.key && $('auto').checked) {
      setLive('poll', 'Reconnecting…');
      state.retryId = setTimeout(function () { state.retryId = null; startStream(); }, POLL_MS);
    }
  }

  function stopStream() {
    if (state.retryId) { clearTimeout(state.retryId); state.retryId = null; }
    var c = state.streamAbort;
    state.streamAbort = null;
    state.streamLive = false;
    if (c) { try { c.abort(); } catch (e) {} }
  }

  function startLive() {
    stopLive();
    if (!$('auto').checked) { setLive('off', 'Paused'); return; }
    startStream();
    state.pollId = setInterval(function () {
      if (document.hidden || state.streamLive) return;
      load();
    }, POLL_MS);
  }

  function stopLive() {
    stopStream();
    if (state.pollId) { clearInterval(state.pollId); state.pollId = null; }
  }

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function inRange(r) {
    if (state.range === 'all') return true;
    if (!r.createdAt) return false;
    if (state.range === 'today') return dayKey(r.createdAt) === dayKey(Date.now());
    var k = dayKey(r.createdAt);
    if (state.from && k < state.from) return false;
    if (state.to && k > state.to) return false;
    return true;
  }

  function scoped() {
    return state.rows.filter(inRange);
  }

  function fmtDay(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function rangeLabel() {
    if (state.range === 'today') return 'Today';
    if (state.range === 'date' && (state.from || state.to)) {
      if (state.from && state.to) return state.from === state.to ? fmtDay(state.from) : fmtDay(state.from) + ' – ' + fmtDay(state.to);
      return state.from ? 'From ' + fmtDay(state.from) : 'Until ' + fmtDay(state.to);
    }
    return '';
  }

  function matches(r) {
    if (!inRange(r)) return false;
    if (state.filter !== 'all' && r.category !== state.filter) return false;
    if (state.channel && r.channel !== state.channel) return false;
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    var hay = [r.senderUsername, r.recipientUsername, r.senderId, r.senderPhone, r.recipient, r.reason, reasonText(r.reason), r.requestId, r.id, r.status, r.txHash, r.sorobanTxHash]
      .join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function counts() {
    var base = scoped();
    var c = { all: base.length, settled: 0, progress: 0, rejected: 0, failed: 0 };
    base.forEach(function (r) { c[r.category]++; });
    return c;
  }

  function renderKpis(c) {
    var settledVolume = 0;
    scoped().forEach(function (r) { if (r.category === 'settled' && r.amount) settledVolume += r.amount; });
    var rate = c.all ? Math.round((c.settled / c.all) * 100) : 0;
    var items = [
      ['Total requests', c.all, '📨', '', rangeLabel() || 'Latest 200 records'],
      ['Settled', c.settled, '✅', 'k-ok', rate + '% success · ' + fmtAmount(settledVolume) + ' XLM'],
      ['In progress', c.progress, '⏳', 'k-wait', 'Awaiting settlement'],
      ['Rejected', c.rejected, '🛡️', 'k-bad', 'Failed validation'],
      ['Failed', c.failed, '⚠️', 'k-bad', 'Settlement errors']
    ];
    $('kpis').innerHTML = items.map(function (it) {
      return '<div class="card kpi ' + it[3] + '"><div class="kpi-top"><span class="kpi-label">' + it[0]
        + '</span><span class="kpi-icon">' + it[2] + '</span></div><div class="kpi-n">' + it[1]
        + '</div><div class="kpi-sub">' + esc(it[4]) + '</div></div>';
    }).join('');
  }

  function renderOverview(c) {
    var total = c.all || 1;
    function w(n) { return (n / total * 100).toFixed(2) + '%'; }
    $('ovTotal').textContent = c.all + ' total';
    $('dist').innerHTML = c.all
      ? '<i class="d-ok" style="width:' + w(c.settled) + '"></i><i class="d-wait" style="width:' + w(c.progress)
        + '"></i><i class="d-rej" style="width:' + w(c.rejected) + '"></i><i class="d-fail" style="width:' + w(c.failed) + '"></i>'
      : '';
    $('legend').innerHTML = [
      ['var(--success)', 'Settled', c.settled],
      ['var(--warning)', 'In progress', c.progress],
      ['var(--danger)', 'Rejected', c.rejected],
      ['#B91C1C', 'Failed', c.failed]
    ].map(function (l) {
      return '<span><b style="background:' + l[0] + '"></b>' + l[1] + ' · ' + l[2] + '</span>';
    }).join('');

    var tally = {};
    scoped().forEach(function (r) {
      if (!r.reason) return;
      var label = reasonText(r.reason);
      tally[label] = (tally[label] || 0) + 1;
    });
    var top = Object.keys(tally).map(function (k) { return [k, tally[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4);
    $('reasons').innerHTML = top.length
      ? top.map(function (t) {
          return '<div class="reason-row"><span class="rn">' + esc(t[0]) + '</span><span class="rb"><i style="width:'
            + (t[1] / top[0][1] * 100).toFixed(0) + '%"></i></span><span class="rc">' + t[1] + '</span></div>';
        }).join('')
      : '<div class="none-note">No rejected or failed requests' + (rangeLabel() ? ' for this period.' : ' yet.') + '</div>';
  }

  function renderChips(c) {
    ['all', 'settled', 'progress', 'rejected', 'failed'].forEach(function (k) {
      var el = $('n-' + k);
      if (el) el.textContent = c[k];
    });
  }

  function renderAuditCard(a) {
    if (!a) return '';
    if (a.error) return '<div class="audit-card" style="color:var(--danger);font-weight:700;">' + esc(a.error) + '</div>';
    return '<div class="audit-card"><dl class="kv" style="margin:0;">'
      + '<dt>Request ID</dt><dd>' + esc(a.requestId) + '</dd>'
      + '<dt>Status</dt><dd>' + esc(a.status || '—') + '</dd>'
      + '<dt>Channel</dt><dd>' + esc(a.channel || '—') + '</dd>'
      + '<dt>Settlements</dt><dd>' + esc(a.settlements) + '</dd>'
      + '<dt>Replay count</dt><dd>' + esc(a.replayCount) + '</dd>'
      + '<dt>Last replay</dt><dd>' + esc(a.lastReplayAt ? fmtTime(Date.parse(a.lastReplayAt)) : '—') + '</dd>'
      + '<dt>Replay channel</dt><dd>' + esc(a.lastReplayChannel || '—') + '</dd>'
      + '<dt>Original TX</dt><dd>' + (a.txHash ? '<a href="' + EXPLORER_TX + encodeURIComponent(a.txHash) + '" target="_blank" rel="noopener noreferrer">' + esc(a.txHash.slice(0, 16)) + '…</a>' : 'none') + '</dd>'
      + '</dl></div>';
  }

  function renderDetails(r) {
    var sig = 'Not checked';
    if (r.validation) {
      sig = r.validation.result === 'passed'
        ? 'Passed'
        : 'Failed' + (r.validation.reason ? ' · ' + (REASONS[r.validation.reason] || r.validation.reason) : '');
    }
    var rows = '<dl class="kv">'
      + '<dt>Relay ID</dt><dd>' + esc(r.id) + '</dd>'
      + '<dt>Sender username</dt><dd>' + esc(r.senderUsername ? r.senderUsername : '—') + '</dd>'
      + '<dt>Recipient username</dt><dd>' + esc(r.recipientUsername ? r.recipientUsername : '—') + '</dd>'
      + '<dt>Sender ID</dt><dd>' + esc(r.senderId || '—') + '</dd>'
      + '<dt>Sender phone</dt><dd>' + esc(r.senderPhone || '—') + '</dd>'
      + '<dt>Recipient</dt><dd>' + esc(r.recipient || '—') + '</dd>'
      + '<dt>Signature</dt><dd>' + esc(sig) + '</dd>'
      + '<dt>Request ID</dt><dd>' + esc(r.requestId || '—') + '</dd>'
      + '<dt>Nonce</dt><dd>' + esc(r.nonce || '—') + '</dd>'
      + '<dt>Received</dt><dd>' + esc(fmtTime(r.createdAt)) + '</dd>'
      + '</dl>';

    var timeline = '<div class="sub-title">Status timeline</div><ul class="timeline">' + r.history.map(function (h) {
      var cls = h.status === 'validation_failed' || h.status === 'failed' ? 'bad' : (h.status === 'settled' || h.status === 'confirmed' ? 'good' : '');
      return '<li class="' + cls + '"><span class="t-s">' + esc(String(h.status || '').replace(/_/g, ' ')) + '</span> · <span class="t-d">' + esc(fmtTime(h.at)) + '</span>'
        + (h.detail ? '<div class="t-d">' + esc(reasonText(h.detail)) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';

    var links = '';
    if (r.txHash) links += '<a href="' + EXPLORER_TX + encodeURIComponent(r.txHash) + '" target="_blank" rel="noopener noreferrer">⭐ Payment TX</a>';
    if (r.sorobanTxHash) links += '<a href="' + EXPLORER_TX + encodeURIComponent(r.sorobanTxHash) + '" target="_blank" rel="noopener noreferrer">📜 Contract TX</a>';

    var audit = '';
    if (r.requestId) {
      audit = '<button class="btn ghost" type="button" data-act="audit" data-id="' + esc(r.id) + '">Replay audit</button>'
        + '<div class="audit-out">' + renderAuditCard(state.audits[r.id]) + '</div>';
    }

    return '<div class="details">' + rows + timeline
      + (links ? '<div class="links">' + links + '</div>' : '') + audit + '</div>';
  }

  function renderRow(r) {
    var track = STAGES.map(function (s, i) {
      var cls = '';
      if (r.category === 'settled' || i <= r.reachedIdx) cls = 'done';
      if ((r.category === 'rejected' || r.category === 'failed') && i === r.reachedIdx) cls = 'bad';
      return '<div class="track-step ' + cls + '"><div class="track-bar"></div><div class="track-label">' + s.label + '</div></div>';
    }).join('');
    var open = !!state.open[r.id];

    return '<article class="card tx c-' + r.category + (state.fresh[r.id] ? ' fresh' : '') + '">'
      + '<div class="tx-head"><div class="tx-ico">' + statusIcon(r) + '</div>'
      + '<div class="tx-main"><div class="tx-amt">' + (r.amount != null ? fmtAmount(r.amount) + ' XLM' : '— XLM') + '</div>'
      + '<div class="tx-route"><b>' + esc(senderLabel(r)) + '</b> → <b>' + esc(recipientLabel(r)) + '</b></div></div>'
      + '<span class="pill ' + r.category + '">' + esc(statusLabel(r)) + '</span></div>'
      + '<div class="tx-meta"><span>' + esc(fmtTime(r.createdAt)) + '</span>'
      + (r.channel ? '<span class="badge">' + esc(CHANNELS[r.channel] || r.channel) + '</span>' : '')
      + (!r.senderId ? '<span class="badge warn">No linked account</span>' : '') + '</div>'
      + (r.reason ? '<div class="reason">' + esc(reasonText(r.reason)) + '</div>' : '')
      + '<div class="track">' + track + '</div>'
      + '<div class="tx-actions"><button class="btn ghost" type="button" data-act="toggle" data-id="' + esc(r.id) + '">' + (open ? 'Hide details' : 'View details') + '</button></div>'
      + (open ? renderDetails(r) : '')
      + '</article>';
  }

  function renderList() {
    var rows = state.rows.filter(matches);
    $('count').textContent = '(' + rows.length + ')';
    if (!rows.length) {
      $('list').innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">🔎</div><b>No requests found</b>Try a different filter or search.</div>';
      return;
    }
    $('list').innerHTML = rows.map(renderRow).join('');
  }

  function renderDateBar() {
    Array.prototype.forEach.call($('dateSeg').children, function (b) {
      b.classList.toggle('active', b.getAttribute('data-range') === state.range);
    });
    $('dateFrom').classList.toggle('hidden', state.range !== 'date');
    $('dateTo').classList.toggle('hidden', state.range !== 'date');
    $('dateNote').textContent = state.range === 'all' ? '' : (rangeLabel() ? 'Showing ' + rangeLabel() : 'Pick a date range');
  }

  function render() {
    renderDateBar();
    var c = counts();
    renderKpis(c);
    renderOverview(c);
    renderChips(c);
    renderList();
  }

  async function runAudit(requestId, rowId) {
    var out;
    try {
      var resp = await api('/api/replay-audit/' + encodeURIComponent(requestId));
      if (resp.status === 404) out = { error: 'No record found for this request ID.' };
      else if (!resp.ok) out = { error: 'Lookup failed (' + resp.status + ').' };
      else out = await resp.json();
    } catch (e) {
      out = { error: 'Could not reach the server.' };
    }
    if (rowId) {
      state.audits[rowId] = out;
      renderList();
    } else {
      $('auditOut').innerHTML = renderAuditCard(out);
    }
  }

  function connect() {
    var value = $('keyInput').value.trim();
    if (!value) { $('gateMsg').textContent = 'Enter the admin key.'; return; }
    state.key = value;
    try { sessionStorage.setItem(KEY_STORE, value); } catch (e) {}
    $('gateMsg').textContent = '';
    $('connectBtn').disabled = true;
    load().then(function () {
      $('connectBtn').disabled = false;
      if (state.key) startLive();
    });
  }

  function signOut() {
    try { sessionStorage.removeItem(KEY_STORE); } catch (e) {}
    state.key = '';
    state.rows = [];
    state.seen = null;
    state.open = {};
    state.audits = {};
    $('keyInput').value = '';
    showGate('');
  }


  function anyMs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      var p = Date.parse(v);
      return isNaN(p) ? 0 : p;
    }
    return toMs(v);
  }

  function inDate(d, ms) {
    if (d.range === 'all') return true;
    if (!ms) return false;
    var k = dayKey(ms);
    if (d.range === 'today') return k === dayKey(Date.now());
    if (d.from && k < d.from) return false;
    if (d.to && k > d.to) return false;
    return true;
  }

  function dateNote(d) {
    if (d.range === 'all') return '';
    if (d.range === 'today') return 'Showing Today';
    if (d.from && d.to) return 'Showing ' + (d.from === d.to ? fmtDay(d.from) : fmtDay(d.from) + ' – ' + fmtDay(d.to));
    if (d.from) return 'Showing from ' + fmtDay(d.from);
    if (d.to) return 'Showing until ' + fmtDay(d.to);
    return 'Pick a date range';
  }

  function syncDate(prefix, d, note) {
    var t = dayKey(Date.now());
    Array.prototype.forEach.call($(prefix + 'DateSeg').children, function (b) {
      b.classList.toggle('active', b.getAttribute('data-range') === d.range);
    });
    var from = $(prefix + 'DateFrom');
    var to = $(prefix + 'DateTo');
    from.classList.toggle('hidden', d.range !== 'date');
    to.classList.toggle('hidden', d.range !== 'date');
    from.value = d.from;
    to.value = d.to;
    from.max = d.to || t;
    to.min = d.from;
    to.max = t;
    $(prefix + 'DateNote').textContent = note == null ? dateNote(d) : note;
  }

  function bindDate(prefix, d, after) {
    $(prefix + 'DateSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-range]');
      if (!btn) return;
      d.range = btn.getAttribute('data-range');
      if (d.range === 'date' && !d.from && !d.to) { d.from = dayKey(Date.now()); d.to = d.from; }
      after();
    });
    $(prefix + 'DateFrom').addEventListener('change', function (e) {
      d.from = e.target.value;
      if (d.from && d.to && d.from > d.to) d.to = d.from;
      after();
    });
    $(prefix + 'DateTo').addEventListener('change', function (e) {
      d.to = e.target.value;
      if (d.from && d.to && d.to < d.from) d.from = d.to;
      after();
    });
  }

  function fmtDayLong(key) {
    if (!key || key === 'none') return 'Date unknown';
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function fmtClock(ms) {
    return ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }

  function phoneMatch(u, q) {
    if (!/^[+\d\s()\-]+$/.test(q)) return false;
    var qd = q.replace(/\D/g, '');
    if (qd.length < 3) return false;
    var tries = [qd];
    if (qd.charAt(0) === '0') { tries.push(qd.slice(1)); tries.push('63' + qd.slice(1)); }
    var pool = [u.phone, u.previousPhone].map(function (p) { return String(p || '').replace(/\D/g, ''); });
    return pool.some(function (p) {
      return p && tries.some(function (t) { return p.indexOf(t) !== -1; });
    });
  }

  function userSinceMs(u) {
    var ms = anyMs(u.createdAt);
    if (ms) return ms;
    var s = String(u.memberSince || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
      var p = Date.parse(s);
      if (!isNaN(p)) return p;
    }
    return 0;
  }

  function sinceText(u, a) {
    var ms = (a && anyMs(a.createdAt)) || userSinceMs(u);
    if (!ms) return u.memberSince || '';
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function upKey(u) {
    return String(u.userId || u.uid || u.username || u.name || 'unknown');
  }

  function groupUploads(list) {
    var map = {};
    var out = [];
    list.forEach(function (u) {
      var k = upKey(u);
      if (!map[k]) { map[k] = { key: k, name: '', username: '', items: [], last: 0 }; out.push(map[k]); }
      var g = map[k];
      if (!g.name && u.name) g.name = u.name;
      if (!g.username && u.username) g.username = u.username;
      g.items.push(u);
      var ms = anyMs(u.createdAt);
      if (ms > g.last) g.last = ms;
    });
    out.forEach(function (g) {
      g.items.sort(function (a, b) { return anyMs(b.createdAt) - anyMs(a.createdAt); });
    });
    out.sort(function (a, b) { return b.last - a.last; });
    return out;
  }

  function filteredUploads() {
    var q = state.upQuery.trim().toLowerCase();
    return state.uploads.filter(function (u) {
      if (!inDate(state.upDate, anyMs(u.createdAt))) return false;
      if (!q) return true;
      return [u.name, u.username].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function initials(u) {
    var s = String(u.name || u.username || '?').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }

  function setView(name) {
    $('viewRelay').classList.toggle('hidden', name !== 'relay');
    $('viewUsers').classList.toggle('hidden', name !== 'users');
    $('viewUploads').classList.toggle('hidden', name !== 'uploads');
    Array.prototype.forEach.call($('tabs').children, function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === name);
    });
    if (name === 'users' && !state.usersLoaded) loadUsers();
    if (name === 'uploads' && !state.uploadsLoaded) loadUploads();
  }

  function renderUploads() {
    var list = $('uploadsList');
    var scoped = filteredUploads();
    var groups = groupUploads(scoped);
    syncDate('up', state.upDate);
    $('uploadCount').textContent = state.uploads.length ? '(' + scoped.length + ')' : '';
    if (!state.uploads.length) {
      list.innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">🖼️</div><b>No screenshots yet</b>Screenshots sent from Help &amp; Support will appear here.</div>';
      return;
    }
    if (!groups.length) {
      list.innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">🔎</div><b>No screenshots found</b>Try a different search or date range.</div>';
      return;
    }
    list.innerHTML = groups.map(function (g) {
      var who = g.name || g.username || 'Unknown user';
      var n = g.items.length;
      return '<button type="button" class="card user-card" data-upload-user="' + esc(g.key) + '">'
        + '<span class="avatar">' + esc(initials(g)) + '</span>'
        + '<span class="user-main"><div class="user-name">' + esc(who) + '</div>'
        + '<div class="user-sub">' + (g.username ? '@' + esc(g.username) : '—') + '</div>'
        + '<div class="user-sub">' + n + (n === 1 ? ' screenshot' : ' screenshots') + (g.last ? ' · Latest ' + esc(fmtTime(g.last)) : '') + '</div></span>'
        + '<span class="user-arrow">›</span></button>';
    }).join('');
  }

  async function loadUploads() {
    if (state.uploadsLoading || !state.key) return;
    state.uploadsLoading = true;
    if (!state.uploads.length) {
      $('uploadsList').innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">⏳</div><b>Loading screenshots…</b></div>';
    }
    try {
      var resp = await api('/api/admin/support-uploads');
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      if (!resp.ok) { var failure = new Error('http-' + resp.status); failure.status = resp.status; throw failure; }
      var data = await resp.json();
      state.uploads = Array.isArray(data.uploads) ? data.uploads : [];
      state.uploadsLoaded = true;
      renderUploads();
    } catch (e) {
      var why = 'Check the connection and tap Refresh.';
      if (e && e.status === 404) why = 'The server does not have the uploads endpoint yet. Deploy the updated server.js and restart the server.';
      else if (e && e.status === 429) why = 'Too many requests. Wait a moment, then tap Refresh.';
      else if (e && e.status) why = 'Server error (' + e.status + '). Check the server logs for details.';
      $('uploadsList').innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">⚠️</div><b>Could not load screenshots</b>' + esc(why) + '</div>';
    } finally {
      state.uploadsLoading = false;
    }
  }

  function closeUpload() {
    state.activeUpload = null;
    state.activeUploadUser = null;
    $('userModal').classList.remove('show');
    document.body.classList.remove('lock');
  }

  function renderUploadGroup() {
    var g = groupUploads(filteredUploads()).filter(function (x) { return x.key === state.activeUploadUser; })[0];
    if (!g) { closeUpload(); return; }
    state.activeUpload = null;
    state.upList = g.items.map(function (u) { return u.id; });
    $('umAvatar').textContent = initials(g);
    $('umName').textContent = g.name || g.username || 'Unknown user';
    $('umUser').textContent = g.username ? '@' + g.username : '';
    var days = [];
    var byDay = {};
    g.items.forEach(function (u) {
      var ms = anyMs(u.createdAt);
      var k = ms ? dayKey(ms) : 'none';
      if (!byDay[k]) { byDay[k] = []; days.push(k); }
      byDay[k].push(u);
    });
    $('umBody').innerHTML = days.map(function (k) {
      var tiles = byDay[k].map(function (u) {
        var ms = anyMs(u.createdAt);
        return '<button type="button" class="up-tile" data-upload="' + esc(u.id) + '">'
          + '<img alt="" loading="lazy" src="' + esc(u.thumb) + '">'
          + '<span class="up-tile-t">' + esc(fmtClock(ms) || '—') + '</span>'
          + (u.note ? '<span class="up-tile-n">' + esc(u.note) + '</span>' : '')
          + '</button>';
      }).join('');
      return '<section class="up-day"><div class="up-day-h"><span>' + esc(fmtDayLong(k)) + '</span><em>' + byDay[k].length + '</em></div>'
        + '<div class="up-grid">' + tiles + '</div></section>';
    }).join('');
  }

  function openUploadGroup(key) {
    state.activeUploadUser = key;
    state.activeUpload = null;
    renderUploadGroup();
    if (!state.activeUploadUser) return;
    $('userModal').classList.add('show');
    document.body.classList.add('lock');
    $('umBody').scrollTop = 0;
  }

  function pad2(n) { return ('0' + n).slice(-2); }

  function upFileName(item, image) {
    var ms = anyMs(item.createdAt);
    var d = ms ? new Date(ms) : new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    var who = String(item.username || item.name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
    var m = /^data:image\/([a-z0-9.+-]+)/i.exec(String(image || ''));
    var ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg') : 'png';
    return 'omnipay-' + who + '-' + stamp + '.' + ext;
  }

  function upBar(id, item, image) {
    var i = state.upList.indexOf(id);
    var n = state.upList.length;
    var nav = '';
    if (i > -1 && n > 1) {
      nav = '<button class="btn plain up-step" type="button" data-act="up-prev" aria-label="Previous screenshot"' + (i === 0 ? ' disabled' : '') + '>‹ Prev</button>'
        + '<span class="up-count">' + (i + 1) + ' of ' + n + '</span>'
        + '<button class="btn plain up-step" type="button" data-act="up-next" aria-label="Next screenshot"' + (i === n - 1 ? ' disabled' : '') + '>Next ›</button>';
    }
    var dl = image
      ? '<a class="btn up-dl" href="' + esc(image) + '" download="' + esc(upFileName(item, image)) + '" rel="noopener">Download</a>'
      : '';
    return '<div class="up-bar"><button class="btn plain up-back" type="button" data-act="up-back">‹ Back</button>'
      + '<div class="up-nav">' + nav + dl + '</div></div>';
  }

  function upStep(delta) {
    var i = state.upList.indexOf(state.activeUpload);
    var next = state.upList[i + delta];
    if (i > -1 && next) openUpload(next);
  }

  async function openUpload(id) {
    var item = state.uploads.filter(function (u) { return u.id === id; })[0];
    if (!item) return;
    state.activeUpload = id;
    $('umAvatar').textContent = initials(item);
    $('umName').textContent = item.name || item.username || 'Unknown user';
    $('umUser').textContent = item.username ? '@' + item.username : '';
    $('umBody').innerHTML = upBar(id, item, '') + '<div class="empty"><div class="e-ico">⏳</div><b>Loading image…</b></div>';
    $('userModal').classList.add('show');
    document.body.classList.add('lock');
    $('umBody').scrollTop = 0;
    try {
      var resp = await api('/api/admin/support-uploads/' + encodeURIComponent(id));
      if (resp.status === 401 || resp.status === 503) { closeUpload(); failAuth(resp.status); return; }
      if (!resp.ok) throw new Error('http-' + resp.status);
      var data = await resp.json();
      if (state.activeUpload !== id) return;
      $('umBody').innerHTML = upBar(id, item, data.image) +
        '<img class="up-full" alt="Uploaded screenshot" src="' + esc(data.image) + '">' +
        '<dl class="kv" style="margin-top:14px;">' +
          '<dt>Uploaded</dt><dd>' + esc(fmtTime(anyMs(data.createdAt))) + '</dd>' +
          '<dt>User</dt><dd>' + esc(data.name || '—') + (data.username ? ' (@' + esc(data.username) + ')' : '') + '</dd>' +
          '<dt>Note</dt><dd>' + esc(data.note || '—') + '</dd>' +
        '</dl>';
    } catch (e) {
      if (state.activeUpload !== id) return;
      $('umBody').innerHTML = upBar(id, item, '') + '<div class="empty"><div class="e-ico">⚠️</div><b>Could not load the image</b>Go back and try again.</div>';
    }
  }

  async function loadUsers() {
    if (state.usersLoading || !state.key) return;
    state.usersLoading = true;
    if (!state.users.length) {
      $('usersList').innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">⏳</div><b>Loading users…</b></div>';
    }
    try {
      var resp = await api('/api/admin/users');
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      if (!resp.ok) { var failure = new Error('http-' + resp.status); failure.status = resp.status; throw failure; }
      var data = await resp.json();
      state.users = Array.isArray(data.users) ? data.users : [];
      if (data.defaultPassword) state.defaultPassword = data.defaultPassword;
      if (data.defaultPin) state.defaultPin = data.defaultPin;
      state.usersLoaded = true;
      renderUsers();
    } catch (e) {
      var why = 'Check the connection and tap Refresh.';
      if (e && e.status === 404) why = 'The server does not have the users endpoint yet. Deploy the updated server.js and restart the server.';
      else if (e && e.status === 429) why = 'Too many requests. Wait a moment, then tap Refresh.';
      else if (e && e.status) why = 'Server error (' + e.status + '). Check the server logs for details.';
      $('usersList').innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">⚠️</div><b>Could not load users</b>' + esc(why) + '</div>';
    } finally {
      state.usersLoading = false;
    }
  }

  function isTxHash(q) { return /^[0-9a-f]{64}$/i.test(q); }

  function userByRef(id, ref) {
    var key = String(ref || '').toLowerCase();
    return state.users.filter(function (u) {
      return (id && u.id === id) || (key && ((u.username || '').toLowerCase() === key || (u.walletPublic || '').toLowerCase() === key));
    })[0];
  }

  async function runLookup(q) {
    state.lookupQ = q;
    state.lookupBusy = true;
    state.lookupRes = null;
    renderUsers();
    try {
      var resp = await api('/api/admin/lookup?q=' + encodeURIComponent(q));
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      if (state.lookupQ !== q) return;
      if (!resp.ok) throw new Error('http-' + resp.status);
      var data = await resp.json();
      state.lookupRes = (data.matches || []).map(function (m) {
        return Object.assign(normalize(m), { matched: m.matched });
      });
    } catch (e) {
      if (state.lookupQ !== q) return;
      state.lookupRes = 'error';
    }
    state.lookupBusy = false;
    renderUsers();
  }

  function txHit(p) {
    var sms = p.channel === 'sms';
    var via = '<span class="um-via ' + (sms ? 'sms' : 'online') + '">' + (sms ? '📱 SMS' : '🌐 Online') + '</span>';
    var cls = p.category === 'settled' ? 'ok' : (p.category === 'progress' ? 'warn' : 'bad');
    var sender = userByRef(p.senderId, p.senderUsername);
    var recipient = userByRef('', p.recipientUsername || p.recipient);
    var senderLabel = sender ? (sender.name || sender.username) : (p.senderUsername || p.senderPhone || 'Unknown sender');
    var senderSub = sender && sender.username && sender.name ? sender.username : '';
    var recipientLabel = recipient ? (recipient.name || recipient.username) : shortHash(p.recipientUsername || p.recipient || 'Unknown');
    var recipientSub = recipient && recipient.username && recipient.name ? recipient.username : '';
    var method = !sms && CHANNELS[p.channel] ? ' · ' + esc(CHANNELS[p.channel]) : '';
    var actions = '';
    if (sender) actions += '<button class="btn plain" type="button" data-user="' + esc(sender.id) + '">View sender</button>';
    if (recipient && (!sender || recipient.id !== sender.id)) actions += '<button class="btn plain" type="button" data-user="' + esc(recipient.id) + '">View recipient</button>';
    return '<div class="card tx-hit"><div class="um-pay-top">' + via + chip(cls, esc(statusLabel(p)))
      + '<span class="um-pay-amt">' + (p.amount == null ? '—' : esc(fmtAmount(p.amount))) + '</span></div>'
      + '<div class="tx-flow"><div><span>From</span><b>' + esc(senderLabel) + '</b>' + (senderSub ? '<small>' + esc(senderSub) + '</small>' : '') + '</div>'
      + '<i aria-hidden="true">→</i>'
      + '<div><span>To</span><b>' + esc(recipientLabel) + '</b>' + (recipientSub ? '<small>' + esc(recipientSub) + '</small>' : '') + '</div></div>'
      + '<div class="um-pay-meta">' + esc(fmtTime(p.createdAt)) + ' · Matched ' + (p.matched === 'contract' ? 'contract' : 'payment') + ' hash' + method + '</div>'
      + (p.txHash ? hashLine('Payment', p.txHash) : '')
      + (p.sorobanTxHash ? hashLine('Contract', p.sorobanTxHash) : '')
      + (actions ? '<div class="tx-actions">' + actions + '</div>' : '')
      + '</div>';
  }

  function renderLookup(q) {
    $('userCount').textContent = '';
    if (state.lookupQ !== q) { runLookup(q); return; }
    var box = $('usersList');
    if (state.lookupBusy) {
      box.innerHTML = '<div class="card empty tx-wide"><div class="e-ico">⏳</div><b>Searching…</b>Looking up this transaction hash.</div>';
      return;
    }
    if (state.lookupRes === 'error') {
      box.innerHTML = '<div class="card empty tx-wide"><div class="e-ico">⚠️</div><b>Search failed</b>Please try again.</div>';
      return;
    }
    if (!state.lookupRes || !state.lookupRes.length) {
      box.innerHTML = '<div class="card empty tx-wide"><div class="e-ico">🔎</div><b>No transaction found</b>This hash is not in the relay records.</div>';
      return;
    }
    box.innerHTML = state.lookupRes.map(txHit).join('');
  }

  function renderUsers() {
    var q = state.userQuery.trim().toLowerCase();
    if (isTxHash(q)) { renderLookup(q); return; }
    var dated = state.users.some(function (u) { return userSinceMs(u) > 0; });
    var rows = state.users.filter(function (u) {
      if (!inDate(state.userDate, userSinceMs(u))) return false;
      if (!q) return true;
      if (phoneMatch(u, q)) return true;
      return [u.name, u.username, u.email, u.phone, u.id, u.walletPublic].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    syncDate('user', state.userDate, state.userDate.range !== 'all' && state.usersLoaded && !dated
      ? 'No account dates available yet'
      : dateNote(state.userDate));
    $('userCount').textContent = '(' + rows.length + ')';
    if (!rows.length) {
      $('usersList').innerHTML = '<div class="card empty" style="grid-column:1/-1;"><div class="e-ico">🔎</div><b>No users found</b>Try a different search or date range.</div>';
      return;
    }
    $('usersList').innerHTML = rows.map(function (u) {
      var ms = userSinceMs(u);
      var since = ms ? 'Member since ' + new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : (u.memberSince ? 'Member since ' + u.memberSince : '');
      return '<button class="card user-card" type="button" data-user="' + esc(u.id) + '">'
        + '<span class="avatar">' + esc(initials(u)) + '</span>'
        + '<span class="user-main"><div class="user-name">' + esc(u.name || u.username || 'Unnamed user') + '</div>'
        + '<div class="user-sub">' + esc(u.username ? u.username : '—') + (u.email ? ' · ' + esc(u.email) : '') + '</div>'
        + '<div class="user-sub">' + esc(u.phone || 'No phone') + '</div>'
        + (since ? '<div class="user-sub">' + esc(since) + '</div>' : '')
        + (q && u.walletPublic && u.walletPublic.toLowerCase().indexOf(q) !== -1 ? '<div class="user-sub">Wallet · ' + esc(shortHash(u.walletPublic)) + '</div>' : '')
        + '</span>'
        + '<span class="user-arrow">›</span></button>';
    }).join('');
  }

  function yesNo(v) { return v ? 'Yes' : 'No'; }

  function chip(cls, text) { return '<span class="um-chip ' + cls + '">' + text + '</span>'; }

  function rows(pairs) {
    return '<div class="um-rows">' + pairs.map(function (p) {
      var empty = p[1] == null || p[1] === '';
      var copy = !empty && p[2]
        ? '<button class="um-copy" type="button" data-copy="' + esc(p[1]) + '" aria-label="Copy ' + esc(p[0]) + '">Copy</button>'
        : '';
      return '<div class="um-row"><div class="um-k">' + esc(p[0]) + '</div>'
        + '<div class="um-v' + (p[3] ? ' mono' : '') + '">' + esc(empty ? '—' : p[1]) + '</div>' + copy + '</div>';
    }).join('') + '</div>';
  }

  function section(icon, title, inner) {
    return '<section class="um-sec"><div class="um-sec-h"><span class="um-sec-i">' + icon + '</span>' + title + '</div>' + inner + '</section>';
  }

  function stat(label, value) {
    return '<div class="um-stat"><span>' + label + '</span><b>' + esc(value) + '</b></div>';
  }

  function shortHash(h) {
    var t = String(h || '');
    return t.length > 20 ? t.slice(0, 10) + '…' + t.slice(-8) : t;
  }

  function hashLine(label, h) {
    return '<div class="um-hash"><span>' + label + '</span><code title="' + esc(h) + '">' + esc(shortHash(h)) + '</code>'
      + '<button class="um-copy" type="button" data-copy="' + esc(h) + '" aria-label="Copy ' + esc(label) + ' hash">Copy</button>'
      + '<a class="um-link" href="' + EXPLORER_TX + encodeURIComponent(h) + '" target="_blank" rel="noopener noreferrer">View</a></div>';
  }

  function payItem(p) {
    var sms = p.channel === 'sms';
    var via = '<span class="um-via ' + (sms ? 'sms' : 'online') + '">' + (sms ? '📱 SMS' : '🌐 Online') + '</span>';
    var cls = p.category === 'settled' ? 'ok' : (p.category === 'progress' ? 'warn' : 'bad');
    var to = p.recipientUsername || p.recipient || 'Unknown';
    var method = !sms && CHANNELS[p.channel] ? ' · ' + esc(CHANNELS[p.channel]) : '';
    var why = (p.category === 'rejected' || p.category === 'failed') && p.reason
      ? '<div class="um-pay-why">' + esc(reasonText(p.reason)) + '</div>'
      : '';
    return '<div class="um-pay"><div class="um-pay-top">' + via + chip(cls, esc(statusLabel(p)))
      + '<span class="um-pay-amt">' + (p.amount == null ? '—' : esc(fmtAmount(p.amount))) + '</span></div>'
      + '<div class="um-pay-meta">To <b>' + esc(shortHash(to)) + '</b> · ' + esc(fmtTime(p.createdAt)) + method + '</div>'
      + why
      + (p.txHash ? hashLine('Payment', p.txHash) : '')
      + (p.sorobanTxHash ? hashLine('Contract', p.sorobanTxHash) : '')
      + '</div>';
  }

  function paymentsBlock() {
    var list = state.activePayments;
    if (list === 'error') return '<div class="um-empty">Payment history could not be loaded.</div>';
    if (!list) return '<div class="um-empty">Loading payment history…</div>';
    if (!list.length) return '<div class="um-empty">No payments sent by this user yet.</div>';
    var onlineCount = list.filter(function (p) { return p.channel !== 'sms'; }).length;
    var tabs = [['all', 'All', list.length], ['online', 'Online', onlineCount], ['sms', 'SMS', list.length - onlineCount]];
    var head = '<div class="um-pay-tabs" role="group" aria-label="Filter payments">' + tabs.map(function (t) {
      var on = state.payFilter === t[0];
      return '<button class="um-tab' + (on ? ' active' : '') + '" type="button" data-act="pay-filter" data-val="' + t[0] + '" aria-pressed="' + on + '">'
        + t[1] + '<em>' + t[2] + '</em></button>';
    }).join('') + '</div>';
    var shown = list.filter(function (p) {
      if (state.payFilter === 'sms') return p.channel === 'sms';
      if (state.payFilter === 'online') return p.channel !== 'sms';
      return true;
    });
    if (!shown.length) return head + '<div class="um-empty">No ' + (state.payFilter === 'sms' ? 'SMS' : 'online') + ' payments for this user.</div>';
    var visible = shown.slice(0, state.payShown);
    var more = shown.length > visible.length
      ? '<div class="um-more"><button class="btn plain" type="button" data-act="pay-more">Show more (' + (shown.length - visible.length) + ')</button></div>'
      : '';
    return head + visible.map(payItem).join('') + more;
  }

  function recovery(o) {
    var body;
    if (o.busy) {
      body = '<div class="reset-actions"><button class="btn danger" type="button" disabled>' + o.busyText + '</button></div>';
    } else if (o.confirm) {
      body = '<p class="um-confirm">' + o.confirmText + '</p>'
        + '<div class="reset-actions"><button class="btn danger" type="button" data-act="' + o.doAct + '">Yes, reset</button>'
        + '<button class="btn plain" type="button" data-act="' + o.cancelAct + '">Cancel</button></div>';
    } else {
      body = '<div class="reset-actions"><button class="btn danger" type="button" data-act="' + o.askAct + '">' + o.label + '</button></div>';
    }
    var msg = o.msg ? '<div class="reset-msg ' + (o.msg.ok ? 'ok' : 'err') + '">' + esc(o.msg.text) + '</div>' : '';
    return '<div class="um-recover"><div class="um-recover-h"><span class="um-recover-i">' + o.icon + '</span>'
      + '<div><b>' + o.title + '</b><p>' + o.hint + '</p></div></div>' + body + msg + '</div>';
  }

  function resetEdit() {
    state.editOpen = false;
    state.editBusy = false;
    state.editMsg = null;
    state.editPhone = '';
    state.editEmail = '';
  }

  function formatPhoneInput(raw) {
    var value = String(raw || '').trim();
    var digits = value.replace(/\D/g, '');
    var national = '';
    if (/^09\d{9}$/.test(digits)) national = digits.slice(1);
    else if (/^639\d{9}$/.test(digits)) national = digits.slice(2);
    else if (/^9\d{9}$/.test(digits) && value.charAt(0) !== '+') national = digits;
    if (national) return '+63 ' + national.slice(0, 3) + ' ' + national.slice(3, 6) + ' ' + national.slice(6);
    return value;
  }

  function contactBlock() {
    var msg = state.editMsg
      ? '<div class="reset-msg ' + (state.editMsg.ok ? 'ok' : 'err') + '">' + esc(state.editMsg.text) + '</div>'
      : '';
    if (!state.editOpen) {
      return '<div class="um-recover"><div class="um-recover-h"><span class="um-recover-i info">✏️</span>'
        + '<div><b>Phone and email</b><p>Correct the mobile number or email address linked to this user.</p></div></div>'
        + '<div class="reset-actions"><button class="btn" type="button" data-act="edit-open">Edit contact details</button></div>'
        + msg + '</div>';
    }
    var dis = state.editBusy ? ' disabled' : '';
    return '<div class="um-recover"><div class="um-recover-h"><span class="um-recover-i info">✏️</span>'
      + '<div><b>Edit contact details</b><p>Leave a field unchanged if it should stay the same.</p></div></div>'
      + '<div class="um-form">'
      + '<label class="um-label" for="editPhone">Mobile number</label>'
      + '<input class="field" id="editPhone" type="tel" inputmode="tel" autocomplete="off" placeholder="+63 9XX XXX XXXX" value="' + esc(state.editPhone) + '"' + dis + '>'
      + '<label class="um-label" for="editEmail">Email address</label>'
      + '<input class="field" id="editEmail" type="email" inputmode="email" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="name@example.com" value="' + esc(state.editEmail) + '"' + dis + '>'
      + '<p class="um-note">Changing the email also changes the address used to sign in, and signs this user out of all devices.</p>'
      + '<div class="reset-actions"><button class="btn" type="button" data-act="edit-save"' + dis + '>' + (state.editBusy ? 'Saving…' : 'Save changes') + '</button>'
      + '<button class="btn plain" type="button" data-act="edit-cancel"' + dis + '>Cancel</button></div>'
      + '</div>' + msg + '</div>';
  }

  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('done'); }, 1200);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function renderUserModal() {
    var u = state.activeUser;
    if (!u) return;
    var a = state.activeAuth;
    $('umAvatar').textContent = initials(u);
    $('umName').textContent = u.name || u.username || 'Unnamed user';
    $('umUser').textContent = u.username || '—';

    var chips = [];
    if (a) {
      chips.push(a.emailVerified ? chip('ok', '✓ Email verified') : chip('warn', 'Email not verified'));
      if (a.disabled) chips.push(chip('bad', 'Login disabled'));
    }
    chips.push(u.hasPin ? chip('ok', 'PIN set') : chip('warn', 'No PIN'));
    if (u.walletResetPending) chips.push(chip('warn', 'Wallet reset pending'));
    if (u.cardFrozen) chips.push(chip('bad', 'Card frozen'));
    if (u.vaultLocked) chips.push(chip('bad', 'Vault locked'));
    if (u.type) chips.push(chip('', esc(u.type)));

    var stats = '<div class="um-stats">'
      + stat('Balance', u.balance == null ? '—' : fmtAmount(u.balance))
      + stat('XLM balance', u.xlmBalance == null ? '—' : fmtAmount(u.xlmBalance))
      + stat('Daily limit', u.dailyLimit == null ? '—' : fmtAmount(u.dailyLimit))
      + stat('Trust score', u.trustScore == null ? '—' : u.trustScore)
      + '</div>';

    var account = rows([
      ['Full name', u.name],
      ['Username', u.username, true],
      ['Email', u.email, true],
      ['Phone', u.phone, true],
      ['Previous phone', u.previousPhone],
      ['Phone changed', u.phoneChangedAt ? fmtTime(toMs(u.phoneChangedAt)) : ''],
      ['Account type', u.type],
      ['Country', u.country],
      ['Member since', sinceText(u, a)],
      ['User ID', u.id, true, true]
    ]);

    var wallet = rows([
      ['Wallet address', u.walletPublic, true, true],
      ['Good transactions', u.goodTxCount]
    ]);

    var security = rows([
      ['SMS PIN set', yesNo(u.hasPin)],
      ['Card frozen', yesNo(u.cardFrozen)],
      ['Vault locked', yesNo(u.vaultLocked)],
      ['Email verified', a ? yesNo(a.emailVerified) : ''],
      ['Login disabled', a ? yesNo(a.disabled) : ''],
      ['Account created', a && a.createdAt ? fmtTime(Date.parse(a.createdAt)) : ''],
      ['Last sign-in', a && a.lastSignInAt ? fmtTime(Date.parse(a.lastSignInAt)) : '']
    ]);

    var pw = esc(state.defaultPassword);
    var pin = esc(state.defaultPin);
    var recover = recovery({
      icon: '🔑',
      title: 'Password',
      hint: 'Use this when a user is locked out. They can sign in right away with the reset password.',
      busy: state.resetBusy,
      busyText: 'Resetting…',
      confirm: state.resetConfirm,
      confirmText: 'Set the password to <b>' + pw + '</b> and sign this user out of all devices?',
      askAct: 'reset-ask',
      doAct: 'reset-do',
      cancelAct: 'reset-cancel',
      label: 'Reset password to ' + pw,
      msg: state.resetMsg
    }) + recovery({
      icon: '🔢',
      title: 'SMS PIN',
      hint: 'Use this when a user forgot their PIN. The old PIN stops working right away.',
      busy: state.pinBusy,
      busyText: 'Resetting…',
      confirm: state.pinConfirm,
      confirmText: 'Set the PIN to <b>' + pin + '</b>? The current PIN will stop working.',
      askAct: 'pin-ask',
      doAct: 'pin-do',
      cancelAct: 'pin-cancel',
      label: 'Reset PIN to ' + pin,
      msg: state.pinMsg
    }) + recovery({
      icon: '💼',
      title: 'Wallet',
      hint: u.walletResetPending
        ? 'A new wallet will be created automatically the next time this user signs in.'
        : 'Use this when a wallet is locked and cannot be opened. The user gets a new wallet address on their next sign-in.',
      busy: state.walletBusy,
      busyText: 'Resetting…',
      confirm: state.walletConfirm,
      confirmText: 'Reset this wallet? The user will get a <b>new wallet address</b> on their next sign-in, and the current wallet key will no longer be used.',
      askAct: 'wallet-ask',
      doAct: 'wallet-do',
      cancelAct: 'wallet-cancel',
      label: u.walletResetPending ? 'Reset wallet again' : 'Reset wallet',
      msg: state.walletMsg
    });

    var payCount = Array.isArray(state.activePayments) ? state.activePayments.length : null;
    var tabDefs = [['profile', 'Profile', null], ['wallet', 'Wallet', null], ['payments', 'Payment history', payCount]];
    var tabBar = '<div class="um-tabs" role="tablist">' + tabDefs.map(function (t) {
      var on = state.umTab === t[0];
      return '<button class="um-mtab' + (on ? ' active' : '') + '" type="button" role="tab" aria-selected="' + on + '" data-act="um-tab" data-val="' + t[0] + '">'
        + t[1] + (t[2] != null ? '<em>' + t[2] + '</em>' : '') + '</button>';
    }).join('') + '</div>';

    var content;
    if (state.umTab === 'wallet') content = section('💼', 'Wallet', wallet);
    else if (state.umTab === 'payments') content = section('🧾', 'Payment history', paymentsBlock());
    else content = section('👤', 'Account', account)
      + section('✏️', 'Contact details', contactBlock())
      + section('🛡️', 'Security', security)
      + section('🛟', 'Account recovery', recover);

    $('umBody').innerHTML = '<div class="um-chips">' + chips.join('') + '</div>'
      + stats
      + tabBar
      + content;
  }

  async function openUser(id) {
    var u = state.users.filter(function (x) { return x.id === id; })[0];
    if (!u) return;
    state.activeUser = u;
    state.activeAuth = null;
    state.activePayments = null;
    state.payFilter = 'all';
    state.payShown = 10;
    state.umTab = 'profile';
    state.resetConfirm = false;
    state.resetBusy = false;
    state.resetMsg = null;
    state.pinConfirm = false;
    state.pinBusy = false;
    state.pinMsg = null;
    state.walletConfirm = false;
    state.walletBusy = false;
    state.walletMsg = null;
    resetEdit();
    renderUserModal();
    $('userModal').classList.add('show');
    document.body.classList.add('lock');
    $('umBody').scrollTop = 0;
    try {
      var resp = await api('/api/admin/users/' + encodeURIComponent(id));
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      if (!resp.ok) { paymentsFailed(id); return; }
      var data = await resp.json();
      if (state.activeUser && state.activeUser.id === id) {
        if (data.user) state.activeUser = data.user;
        state.activeAuth = data.auth || null;
        state.activePayments = Array.isArray(data.payments)
          ? data.payments.map(normalize).sort(function (a, b) { return b.createdAt - a.createdAt; })
          : 'error';
        renderUserModal();
      }
    } catch (e) { paymentsFailed(id); }
  }

  function paymentsFailed(id) {
    if (state.activeUser && state.activeUser.id === id && !Array.isArray(state.activePayments)) {
      state.activePayments = 'error';
      renderUserModal();
    }
  }

  function closeUser() {
    state.activeUpload = null;
    state.activeUploadUser = null;
    state.activeUser = null;
    state.activeAuth = null;
    state.activePayments = null;
    state.resetConfirm = false;
    state.resetBusy = false;
    state.resetMsg = null;
    state.pinConfirm = false;
    state.pinBusy = false;
    state.pinMsg = null;
    state.walletConfirm = false;
    state.walletBusy = false;
    state.walletMsg = null;
    resetEdit();
    $('userModal').classList.remove('show');
    document.body.classList.remove('lock');
  }

  async function resetPassword() {
    var u = state.activeUser;
    if (!u || state.resetBusy) return;
    state.resetBusy = true;
    state.resetConfirm = false;
    state.resetMsg = null;
    renderUserModal();
    try {
      var resp = await fetch('/api/admin/users/' + encodeURIComponent(u.id) + '/reset-password', {
        method: 'POST',
        headers: { 'x-admin-key': state.key }
      });
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      var data = {};
      try { data = await resp.json(); } catch (e) {}
      if (!resp.ok) throw new Error(data.error || ('http-' + resp.status));
      state.resetMsg = { ok: true, text: 'Password reset. The user can now sign in with ' + (data.password || state.defaultPassword) + '.' };
    } catch (e) {
      state.resetMsg = { ok: false, text: 'Could not reset the password: ' + (e.message || 'unknown error') };
    } finally {
      state.resetBusy = false;
      renderUserModal();
    }
  }

  async function resetWallet() {
    var u = state.activeUser;
    if (!u || state.walletBusy) return;
    state.walletBusy = true;
    state.walletConfirm = false;
    state.walletMsg = null;
    renderUserModal();
    try {
      var resp = await fetch('/api/admin/users/' + encodeURIComponent(u.id) + '/reset-wallet', {
        method: 'POST',
        headers: { 'x-admin-key': state.key }
      });
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      var data = {};
      try { data = await resp.json(); } catch (e) {}
      if (!resp.ok) throw new Error(data.error || ('http-' + resp.status));
      u.walletResetPending = true;
      state.users.forEach(function (x) { if (x.id === u.id) x.walletResetPending = true; });
      state.walletMsg = { ok: true, text: 'Wallet reset. A new wallet is created automatically when the user signs in.' };
    } catch (e) {
      state.walletMsg = { ok: false, text: 'Could not reset the wallet: ' + (e.message || 'unknown error') };
    } finally {
      state.walletBusy = false;
      renderUserModal();
    }
  }

  async function saveContact() {
    var u = state.activeUser;
    if (!u || state.editBusy) return;
    var phone = formatPhoneInput(state.editPhone);
    var email = String(state.editEmail || '').trim().toLowerCase();
    var payload = {};
    if (phone && phone !== String(u.phone || '')) payload.phone = phone;
    if (email && email !== String(u.email || '').toLowerCase()) payload.email = email;
    if (!payload.phone && !payload.email) {
      state.editMsg = { ok: false, text: 'No changes to save.' };
      renderUserModal();
      return;
    }
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      state.editMsg = { ok: false, text: 'Enter a valid email address.' };
      renderUserModal();
      return;
    }
    state.editBusy = true;
    state.editMsg = null;
    renderUserModal();
    try {
      var resp = await fetch('/api/admin/users/' + encodeURIComponent(u.id) + '/update-contact', {
        method: 'POST',
        headers: { 'x-admin-key': state.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      var data = {};
      try { data = await resp.json(); } catch (e) {}
      if (!resp.ok) throw new Error(data.error || ('http-' + resp.status));
      if (data.user) {
        state.activeUser = data.user;
        state.users = state.users.map(function (x) { return x.id === data.user.id ? data.user : x; });
        renderUsers();
      }
      if (data.auth) state.activeAuth = data.auth;
      state.editOpen = false;
      state.editPhone = '';
      state.editEmail = '';
      state.editMsg = { ok: true, text: 'Contact details updated.' };
    } catch (e) {
      var text = String(e && e.message ? e.message : 'unknown error');
      state.editMsg = { ok: false, text: 'Could not save: ' + text.charAt(0).toUpperCase() + text.slice(1) };
    } finally {
      state.editBusy = false;
      renderUserModal();
    }
  }

  async function resetPin() {
    var u = state.activeUser;
    if (!u || state.pinBusy) return;
    state.pinBusy = true;
    state.pinConfirm = false;
    state.pinMsg = null;
    renderUserModal();
    try {
      var resp = await fetch('/api/admin/users/' + encodeURIComponent(u.id) + '/reset-pin', {
        method: 'POST',
        headers: { 'x-admin-key': state.key }
      });
      if (resp.status === 401 || resp.status === 503) { failAuth(resp.status); return; }
      var data = {};
      try { data = await resp.json(); } catch (e) {}
      if (!resp.ok) throw new Error(data.error || ('http-' + resp.status));
      u.hasPin = true;
      state.users.forEach(function (x) { if (x.id === u.id) x.hasPin = true; });
      state.pinMsg = { ok: true, text: 'PIN reset. The user can now confirm payments with ' + (data.pin || state.defaultPin) + '.' };
    } catch (e) {
      state.pinMsg = { ok: false, text: 'Could not reset the PIN: ' + (e.message || 'unknown error') };
    } finally {
      state.pinBusy = false;
      renderUserModal();
    }
  }

  $('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (btn) setView(btn.getAttribute('data-view'));
  });
  $('userSearch').addEventListener('input', function (e) { state.userQuery = e.target.value; renderUsers(); });
  $('usersRefreshBtn').addEventListener('click', loadUsers);
  $('uploadsRefreshBtn').addEventListener('click', loadUploads);
  $('uploadSearch').addEventListener('input', function (e) { state.upQuery = e.target.value; renderUploads(); });
  $('uploadsList').addEventListener('click', function (e) {
    var card = e.target.closest('[data-upload-user]');
    if (card) openUploadGroup(card.getAttribute('data-upload-user'));
  });
  bindDate('user', state.userDate, renderUsers);
  bindDate('up', state.upDate, renderUploads);
  $('usersList').addEventListener('click', function (e) {
    var card = e.target.closest('[data-user]');
    if (card) openUser(card.getAttribute('data-user'));
  });
  $('umClose').addEventListener('click', function () { if (state.activeUpload || state.activeUploadUser) closeUpload(); else closeUser(); });
  $('userModal').addEventListener('click', function (e) {
    if (e.target !== $('userModal')) return;
    if (state.activeUpload || state.activeUploadUser) closeUpload(); else closeUser();
  });
  $('umBody').addEventListener('click', function (e) {
    var tile = e.target.closest('[data-upload]');
    if (tile) { openUpload(tile.getAttribute('data-upload')); return; }
    var back = e.target.closest('[data-act="up-back"]');
    if (back) { renderUploadGroup(); $('umBody').scrollTop = 0; return; }
    var step = e.target.closest('[data-act="up-prev"], [data-act="up-next"]');
    if (step) { upStep(step.getAttribute('data-act') === 'up-next' ? 1 : -1); return; }
    var cp = e.target.closest('[data-copy]');
    if (cp) { copyText(cp.getAttribute('data-copy'), cp); return; }
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'edit-open') {
      var cu = state.activeUser;
      state.editOpen = true;
      state.editMsg = null;
      state.editPhone = cu ? cu.phone || '' : '';
      state.editEmail = cu ? cu.email || '' : '';
      state.resetConfirm = false; state.pinConfirm = false; state.walletConfirm = false;
      renderUserModal();
      return;
    }
    if (act === 'um-tab') { state.umTab = btn.getAttribute('data-val') || 'profile'; renderUserModal(); return; }
    if (act === 'pay-filter') { state.payFilter = btn.getAttribute('data-val') || 'all'; state.payShown = 10; renderUserModal(); return; }
    if (act === 'pay-more') { state.payShown += 10; renderUserModal(); return; }
    if (act === 'edit-cancel') { resetEdit(); renderUserModal(); return; }
    if (act === 'edit-save') { saveContact(); return; }
    if (act === 'reset-ask') { state.resetConfirm = true; state.resetMsg = null; state.pinConfirm = false; state.walletConfirm = false; renderUserModal(); }
    else if (act === 'reset-cancel') { state.resetConfirm = false; renderUserModal(); }
    else if (act === 'reset-do') resetPassword();
    else if (act === 'pin-ask') { state.pinConfirm = true; state.pinMsg = null; state.resetConfirm = false; state.walletConfirm = false; renderUserModal(); }
    else if (act === 'pin-cancel') { state.pinConfirm = false; renderUserModal(); }
    else if (act === 'pin-do') resetPin();
    else if (act === 'wallet-ask') { state.walletConfirm = true; state.walletMsg = null; state.resetConfirm = false; state.pinConfirm = false; renderUserModal(); }
    else if (act === 'wallet-cancel') { state.walletConfirm = false; renderUserModal(); }
    else if (act === 'wallet-do') resetWallet();
  });
  $('umBody').addEventListener('input', function (e) {
    if (e.target.id === 'editPhone') state.editPhone = e.target.value;
    else if (e.target.id === 'editEmail') state.editEmail = e.target.value;
  });
  $('umBody').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.target.id === 'editPhone' || e.target.id === 'editEmail')) {
      e.preventDefault();
      saveContact();
    }
  });
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.activeUpload && state.activeUploadUser) {
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      upStep(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key !== 'Escape') return;
    if (state.activeUpload && state.activeUploadUser) { renderUploadGroup(); $('umBody').scrollTop = 0; }
    else if (state.activeUpload || state.activeUploadUser) closeUpload();
    else if (state.activeUser) closeUser();
  });

  $('connectBtn').addEventListener('click', connect);
  $('keyInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
  $('signOutBtn').addEventListener('click', signOut);
  $('refreshBtn').addEventListener('click', load);
  $('auto').addEventListener('change', function () {
    if ($('auto').checked) { load(); startLive(); } else { stopLive(); setLive('off', 'Paused'); }
  });
  $('dateSeg').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-range]');
    if (!btn) return;
    state.range = btn.getAttribute('data-range');
    if (state.range === 'date') {
      var t = dayKey(Date.now());
      if (!state.from && !state.to) { state.from = t; state.to = t; }
      syncDateInputs();
    }
    render();
  });
  function syncDateInputs() {
    var t = dayKey(Date.now());
    $('dateFrom').value = state.from;
    $('dateTo').value = state.to;
    $('dateFrom').max = state.to || t;
    $('dateTo').min = state.from;
    $('dateTo').max = t;
  }
  $('dateFrom').addEventListener('change', function (e) {
    state.from = e.target.value;
    if (state.from && state.to && state.from > state.to) state.to = state.from;
    syncDateInputs();
    render();
  });
  $('dateTo').addEventListener('change', function (e) {
    state.to = e.target.value;
    if (state.from && state.to && state.to < state.from) state.from = state.to;
    syncDateInputs();
    render();
  });
  $('search').addEventListener('input', function (e) { state.query = e.target.value; renderList(); });
  $('channel').addEventListener('change', function (e) { state.channel = e.target.value; renderList(); });
  $('auditBtn').addEventListener('click', function () {
    var id = $('auditInput').value.trim();
    if (id) runAudit(id, null);
  });
  $('auditInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var id = e.target.value.trim(); if (id) runAudit(id, null); }
  });

  $('chips').addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    state.filter = btn.getAttribute('data-filter');
    Array.prototype.forEach.call($('chips').children, function (c) { c.classList.toggle('active', c === btn); });
    renderList();
  });

  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    if (btn.getAttribute('data-act') === 'toggle') {
      state.open[id] = !state.open[id];
      renderList();
      return;
    }
    if (btn.getAttribute('data-act') === 'audit') {
      var row = state.rows.filter(function (r) { return r.id === id; })[0];
      if (row && row.requestId) runAudit(row.requestId, id);
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !state.key) return;
    load();
    if (!state.streamLive && $('auto').checked) startStream();
  });

  try {
    var saved = sessionStorage.getItem(KEY_STORE);
    if (saved) {
      state.key = saved;
      load().then(function () { if (state.key) startLive(); });
    }
  } catch (e) {}
})();