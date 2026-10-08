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
    query: '',
    open: {},
    audits: {},
    streamAbort: null,
    streamLive: false,
    retryId: null,
    pollId: null,
    loading: false
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
    return r.senderUsername ? '@' + r.senderUsername : (r.senderId || r.senderPhone || 'Unknown sender');
  }

  function recipientLabel(r) {
    if (r.recipientUsername) return '@' + r.recipientUsername;
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

  function matches(r) {
    if (state.filter !== 'all' && r.category !== state.filter) return false;
    if (state.channel && r.channel !== state.channel) return false;
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    var hay = [r.senderUsername, r.recipientUsername, r.senderId, r.senderPhone, r.recipient, r.reason, reasonText(r.reason), r.requestId, r.id, r.status]
      .join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function counts() {
    var c = { all: state.rows.length, settled: 0, progress: 0, rejected: 0, failed: 0 };
    state.rows.forEach(function (r) { c[r.category]++; });
    return c;
  }

  function renderKpis(c) {
    var settledVolume = 0;
    state.rows.forEach(function (r) { if (r.category === 'settled' && r.amount) settledVolume += r.amount; });
    var rate = c.all ? Math.round((c.settled / c.all) * 100) : 0;
    var items = [
      ['Total requests', c.all, '📨', '', 'Latest 200 records'],
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
    state.rows.forEach(function (r) {
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
      : '<div class="none-note">No rejected or failed requests yet.</div>';
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
      + '<dt>Sender username</dt><dd>' + esc(r.senderUsername ? '@' + r.senderUsername : '—') + '</dd>'
      + '<dt>Recipient username</dt><dd>' + esc(r.recipientUsername ? '@' + r.recipientUsername : '—') + '</dd>'
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

  function render() {
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

  $('connectBtn').addEventListener('click', connect);
  $('keyInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
  $('signOutBtn').addEventListener('click', signOut);
  $('refreshBtn').addEventListener('click', load);
  $('auto').addEventListener('change', function () {
    if ($('auto').checked) { load(); startLive(); } else { stopLive(); setLive('off', 'Paused'); }
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