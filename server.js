/**
 * Mission Control — server-side multi-user + ComputerCraft telemetry
 * Port 5105, bind 0.0.0.0
 *
 * Accounts (username + password):
 *   ceo / ISApeak1234          → CEO (full control)
 *   robert / boosterdirector123 → Booster Director
 *   ship / shipdirector123      → Ship Director
 *   admin / ISAadmin            → Admin (vote, chat, request hold)
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const WebSocket = require('ws')

const PORT = Number(process.env.PORT) || 5105
const HOST = process.env.HOST || '0.0.0.0'
const PUBLIC = path.join(__dirname, 'public')

// username (lowercase) → { password, role, title }
// Password → role (display name is free-form from client)
const PASSWORDS = {
  // CEO full control
  [process.env.CEO_PASS || 'ISA-Peak-2026!Sys']: { role: 'ceo', title: 'CEO' },
  [process.env.CEO2_PASS || 'ISA-KZ-Peak-2026!']: { role: 'ceo', title: 'CEO' },
  // Booster Director
  [process.env.BOOSTER_PASS || 'Booster-Dir-2026!']: { role: 'booster_director', title: 'Booster Director' },
  // Ship Director
  [process.env.SHIP_PASS || 'Ship-Dir-2026!']: { role: 'ship_director', title: 'Ship Director' },
  // Admin
  [process.env.ADMIN_PASS || 'ISA-Admin-2026!']: { role: 'admin', title: 'Admin' }
}

const sessions = new Map() // token → { role, name, title, created }
// Pending join requests (non-CEO must be approved by CEO)
// id → { id, name, role, title, passwordHint, at, status: 'pending'|'approved'|'denied' }
const pendingJoins = new Map()

function newToken() {
  return crypto.randomBytes(24).toString('hex')
}

function login(displayName, password) {
  const acc = PASSWORDS[String(password || '')]
  if (!acc) return null
  const name = String(displayName || 'Operator').trim().slice(0, 32) || 'Operator'
  // CEO logs in immediately; everyone else waits for CEO approval
  if (acc.role === 'ceo') {
    const token = newToken()
    const entry = { role: acc.role, name, title: acc.title, created: Date.now() }
    sessions.set(token, entry)
    return { ok: true, immediate: true, token, role: entry.role, name: entry.name, title: entry.title }
  }
  const id = crypto.randomBytes(8).toString('hex')
  pendingJoins.set(id, {
    id,
    name,
    role: acc.role,
    title: acc.title,
    at: Date.now(),
    status: 'pending'
  })
  return { ok: true, immediate: false, pendingId: id, name, role: acc.role, title: acc.title }
}

function approveJoin(pendingId) {
  const p = pendingJoins.get(pendingId)
  if (!p || p.status !== 'pending') return null
  p.status = 'approved'
  const token = newToken()
  const entry = { role: p.role, name: p.name, title: p.title, created: Date.now() }
  sessions.set(token, entry)
  p.token = token
  return { token, role: entry.role, name: entry.name, title: entry.title, pendingId }
}

function denyJoin(pendingId) {
  const p = pendingJoins.get(pendingId)
  if (!p || p.status !== 'pending') return false
  p.status = 'denied'
  return true
}

function sess(token) {
  return token ? sessions.get(token) || null : null
}

function isCeo(s) { return s && s.role === 'ceo' }
function canFlightCmd(s) { return s && (s.role === 'ceo' || s.role === 'booster_director' || s.role === 'ship_director') }

function pendingPublic() {
  return [...pendingJoins.values()]
    .filter(p => p.status === 'pending')
    .map(p => ({ id: p.id, name: p.name, role: p.role, title: p.title, at: p.at }))
}

// ---- Vehicle telemetry (from ComputerCraft) ----
// Extra fields act as "telemetry codes" / status values from CC
function emptyStage(enginesTotal) {
  return {
    altitude: 0, velocity: 0, speedKmh: 0, apogee: 0, downrange: 0,
    vspeed: 0, pitch: 0, yaw: 0, gforce: 0,
    enginesLit: 0, enginesTotal,
    engines: Array(enginesTotal).fill(false),
    // Telemetry codes / extended sensors
    fuelPct: 0, oxPct: 0, chamberPressure: 0, throttle: 0,
    statusCode: 0, statusText: 'NOMINAL',
    battery: 100, signal: 100, temp: 20,
    lastAt: 0
  }
}

const PROGRAMS = {
  starship: {
    id: 'starship',
    name: 'Starship',
    stage1Name: 'BOOSTER',
    stage2Name: 'STARSHIP',
    stage1Engines: 33,
    stage2Engines: 6,
    defaultLabel: 'STARSHIP FLIGHT TEST',
    pollStations: ['Booster', 'Starship', 'Ground']
  },
  eclipse: {
    id: 'eclipse',
    name: 'Eclipse (Falcon 9)',
    stage1Name: 'STAGE 1',
    stage2Name: 'STAGE 2',
    stage1Engines: 9,
    stage2Engines: 1,
    defaultLabel: 'ECLIPSE FLIGHT TEST',
    pollStations: ['Stage 1', 'Stage 2', 'Ground']
  }
}

let vehicleProgram = 'starship' // 'starship' | 'eclipse'

function resetVehicleForProgram(progId) {
  const p = PROGRAMS[progId] || PROGRAMS.starship
  return {
    booster: emptyStage(p.stage1Engines),
    starship: emptyStage(p.stage2Engines)
  }
}

let vehicle = resetVehicleForProgram(vehicleProgram)

let timer = {
  mode: 'up',
  totalMs: 0,
  running: false,
  hold: false,
  aborted: false,
  elapsedMs: 0,
  startTimestamp: 0,
  label: 'STARSHIP FLIGHT TEST',
  t0Utc: null
}

// Stream overlay layout mode controlled by CEO
// auto | countdown | full | booster | ship
let overlayMode = 'auto'

// Individual widget visibility on the stream overlay (CEO)
let widgets = {
  timeline: true,
  boosterEngines: true,
  shipEngines: true,
  gauges: true,
  cornerClock: true
}

// Flight plan recovery profile (CEO)
// booster/ship: 'catch' | 'splashdown'
let flightPlan = {
  booster: 'catch',
  ship: 'catch',
  label: 'Double catch'
}

// Timeline events for the stream arc (CEO-editable)
// t = seconds relative to T-0 (negative = countdown, positive = flight)
const DEFAULT_TIMELINE = [
  { key: 'GO_PROP_LOAD', label: 'GO FOR\nPROP LOAD', pos: 'above', t: -3000 },
  { key: 'BOOSTER_LOX_LOAD', label: 'BOOSTER LOX\nLOAD', pos: 'below', t: -2193 },
  { key: 'BOOSTER_FUEL_LOAD', label: 'BOOSTER FUEL\nLOAD', pos: 'above', t: -2100 },
  { key: 'SHIP_LOX_LOAD', label: 'SHIP LOX\nLOAD', pos: 'below', t: -2053 },
  { key: 'SHIP_FUEL_LOAD', label: 'SHIP FUEL\nLOAD', pos: 'above', t: -2051 },
  { key: 'ENGINE_CHILL', label: 'RAPTOR\nENGINE CHILL', pos: 'below', t: -1300 },
  { key: 'BOOSTER_PROP_COMPLETE', label: 'BOOSTER PROP\nCOMPLETE', pos: 'above', t: -170 },
  { key: 'SHIP_PROP_COMPLETE', label: 'SHIP PROP\nCOMPLETE', pos: 'below', t: -130 },
  { key: 'FLAME_DIVERTER', label: 'FLAME DIVERTER', pos: 'above', t: -17 },
  { key: 'GO_FOR_LAUNCH', label: 'GO FOR\nLAUNCH', pos: 'above', t: -30 },
  { key: 'ENGINE_START', label: 'ENGINE\nSTART', pos: 'below', t: -3 },
  { key: 'LIFTOFF', label: 'LIFTOFF', pos: 'below', t: 0 },
  { key: 'MAXQ', label: 'MAX-Q', pos: 'above', t: 58 },
  { key: 'SUPER_HEAVY_MECO', label: 'SUPER HEAVY\nMECO', pos: 'below', t: 140 },
  { key: 'HOT_STAGE', label: 'HOT-STAGING', pos: 'above', t: 142 },
  { key: 'BOOSTBACK_START', label: 'BOOSTBACK\nSTART', pos: 'below', t: 147 },
  { key: 'BOOSTBACK_SHUTDOWN', label: 'BOOSTBACK\nSHUTDOWN', pos: 'above', t: 187 },
  { key: 'LANDING_BURN_START', label: 'LANDING BURN\nSTART', pos: 'below', t: 395 },
  { key: 'LANDING_BURN_SHUTDOWN', label: 'LANDING BURN\nSHUTDOWN', pos: 'above', t: 421 },
  { key: 'STARSHIP_ENGINE_CUTOFF', label: 'SHIP ENGINE\nCUTOFF', pos: 'below', t: 491 },
  { key: 'PAYLOAD_DEPLOY', label: 'PAYLOAD\nDEPLOY', pos: 'above', t: 2058 },
  { key: 'DEORBIT_START', label: 'DEORBIT BURN\nSTART', pos: 'below', t: 4218 },
  { key: 'DEORBIT_SHUTDOWN', label: 'DEORBIT BURN\nSHUTDOWN', pos: 'above', t: 4229 },
  { key: 'STARSHIP_ENTRY', label: 'STARSHIP\nENTRY', pos: 'below', t: 5332 },
  { key: 'LANDING_BURN', label: 'LANDING BURN\nSTART', pos: 'above', t: 5651 },
  { key: 'LANDING_FLIP', label: 'LANDING\nFLIP', pos: 'below', t: 6013 },
  { key: 'LANDING_3_TO_2', label: '3 → 2\nENGINES', pos: 'above', t: 6021 },
  { key: 'LANDING_2_TO_1', label: '2 → 1\nENGINE', pos: 'below', t: 6022 },
  { key: 'LANDING', label: 'LANDING', pos: 'above', t: 6030 }
]
let timelineEvents = DEFAULT_TIMELINE.map((e, i) => ({
  id: 'tl' + i,
  key: e.key,
  label: e.label,
  pos: e.pos === 'above' ? 'above' : 'below',
  t: Number(e.t) || 0
}))

// Team availability: userKey → { name, title, role, tz, slots: [{ day, start, end }] }
// day: 0=Mon … 6=Sun; start/end: minutes from midnight (e.g. 600 = 10:00)
let availability = {}

let poll = null
let requests = []
let eventLog = []
let chat = [] // { id, name, title, role, text, at, hidden }
let reports = [] // { id, msgId, by, reason, at, msgSnapshot }

// Launch schedule: [{ id, name, vehicle, t0Utc, status, note, createdBy, createdAt }]
// status: planning | approved | scheduled | flown | scrubbed
// Only CEO can set status to "approved"
const SCHEDULE_STATUSES = ['planning', 'approved', 'scheduled', 'flown', 'scrubbed']
let schedule = []

function pushLog(text) {
  eventLog.unshift({ t: Date.now(), text })
  if (eventLog.length > 100) eventLog.length = 100
}

function pushChat(name, title, role, text) {
  const msg = {
    id: crypto.randomBytes(6).toString('hex'),
    name, title, role,
    text: String(text).slice(0, 400),
    at: Date.now(),
    hidden: false
  }
  chat.push(msg)
  if (chat.length > 200) chat.shift()
  return msg
}

function currentElapsed() {
  if (!timer.running) return timer.elapsedMs
  return timer.elapsedMs + (Date.now() - timer.startTimestamp)
}

function timerPublic() {
  return { ...timer, nowMs: currentElapsed(), serverNow: Date.now() }
}

function pollPublic() {
  if (!poll) return null
  const go = Object.values(poll.votes).filter((v) => v === 'go').length
  const nogo = Object.values(poll.votes).filter((v) => v === 'nogo').length
  return {
    id: poll.id, title: poll.title, stations: poll.stations,
    open: poll.open, createdBy: poll.createdBy, createdAt: poll.createdAt,
    go, nogo, total: go + nogo, votes: { ...poll.votes }
  }
}

function schedulePublic() {
  return schedule
    .slice()
    .sort((a, b) => (a.t0Utc || 0) - (b.t0Utc || 0))
    .map((s) => ({ ...s }))
}

function scheduleCounts() {
  const counts = { planning: 0, approved: 0, scheduled: 0, flown: 0, scrubbed: 0 }
  schedule.forEach((e) => {
    if (counts[e.status] != null) counts[e.status]++
  })
  return counts
}

function snapshot() {
  const prog = PROGRAMS[vehicleProgram] || PROGRAMS.starship
  return {
    type: 'state',
    vehicle,
    vehicleProgram,
    programMeta: {
      id: prog.id,
      name: prog.name,
      stage1Name: prog.stage1Name,
      stage2Name: prog.stage2Name,
      stage1Engines: prog.stage1Engines,
      stage2Engines: prog.stage2Engines
    },
    timer: timerPublic(),
    poll: pollPublic(),
    requests: requests.slice(-40),
    log: eventLog.slice(0, 50),
    chat: chat.filter((m) => !m.hidden).slice(-80),
    reports: reports.slice(-50),
    schedule: schedulePublic(),
    scheduleCounts: scheduleCounts(),
    telemetryAge: {
      booster: vehicle.booster.lastAt ? Date.now() - vehicle.booster.lastAt : null,
      starship: vehicle.starship.lastAt ? Date.now() - vehicle.starship.lastAt : null
    },
    overlayMode,
    widgets,
    flightPlan,
    timelineEvents: timelineEvents.slice().sort((a, b) => a.t - b.t),
    availability,
    pendingJoins: pendingPublic(),
    serverNow: Date.now()
  }
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.lua': 'text/plain; charset=utf-8'
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'POST' && url === '/api/login') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}')
        const result = login(data.displayName || data.name || data.username, data.password)
        if (!result) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid username or password' }))
          return
        }
        if (result.immediate) {
          pushLog(`${result.name} (${result.title}) logged in`)
          log(`[login] ${result.name} as ${result.role} from ${req.socket.remoteAddress}`)
        } else {
          pushLog(`${result.name} (${result.title}) requested to join — awaiting CEO`)
          log(`[join-pending] ${result.name} as ${result.role} id=${result.pendingId}`)
          broadcastState()
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }))
      }
    })
    return
  }

  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      clients: wss.clients.size,
      sessions: sessions.size,
      telemetryAge: {
        booster: vehicle.booster.lastAt ? Date.now() - vehicle.booster.lastAt : null,
        starship: vehicle.starship.lastAt ? Date.now() - vehicle.starship.lastAt : null
      }
    }))
    return
  }

  // Poll join approval status (for users waiting on CEO)
  if (req.method === 'GET' && url.startsWith('/api/join-status')) {
    const q = new URL(req.url, 'http://x').searchParams
    const id = q.get('id') || ''
    const p = pendingJoins.get(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (!p) {
      res.end(JSON.stringify({ status: 'unknown' }))
    } else if (p.status === 'approved' && p.token) {
      res.end(JSON.stringify({ status: 'approved', token: p.token, role: p.role, name: p.name, title: p.title }))
    } else {
      res.end(JSON.stringify({ status: p.status }))
    }
    return
  }

  let filePath = url
  if (filePath === '/' || filePath === '/panel' || filePath === '/Panel' || filePath === '/admin') filePath = '/panel.html'
  if (filePath === '/stream' || filePath === '/Panel/Stream' || filePath === '/panel/stream') filePath = '/stream.html'
  if (filePath === '/propellant' || filePath === '/prop' || filePath === '/tanks') filePath = '/propellant.html'
  if (filePath === '/flight-plan' || filePath === '/flightplan' || filePath === '/fp' || filePath === '/trajectory') filePath = '/flight-plan.html'
  if (filePath === '/starting-soon' || filePath === '/startingsoon' || filePath === '/standby') filePath = '/starting-soon.html'
  if (filePath === '/loss-of-signal' || filePath === '/lossofsignal' || filePath === '/los') filePath = '/loss-of-signal.html'

  const safe = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '')
  const full = path.join(PUBLIC, safe)
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found. Try /panel or /stream'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' })
    res.end(data)
  })
})

const wss = new WebSocket.Server({ server, clientTracking: true })

function broadcast(payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload)
  wss.clients.forEach((c) => {
    if (c.readyState !== WebSocket.OPEN) return
    // Slow client (e.g. behind a tunnel): skip instead of piling up a queue -> no growing lag.
    // State is always a full snapshot, so a skipped frame loses nothing.
    if (c.bufferedAmount > 128 * 1024) return
    c.send(msg)
  })
}

// Throttled: telemetry can arrive many times/sec; send at most one snapshot per 100 ms
let _lastBroadcast = 0
let _pendingBroadcast = null
function broadcastState() {
  const wait = 100 - (Date.now() - _lastBroadcast)
  if (wait <= 0) {
    _lastBroadcast = Date.now()
    broadcast(snapshot())
  } else if (!_pendingBroadcast) {
    _pendingBroadcast = setTimeout(() => {
      _pendingBroadcast = null
      _lastBroadcast = Date.now()
      broadcast(snapshot())
    }, wait)
  }
}

function applyTelemetry(side, data) {
  const v = side === 'starship' ? vehicle.starship : vehicle.booster
  if (!data || typeof data !== 'object') return
  if (typeof data.speed === 'number') {
    v.velocity = data.speed
    v.speedKmh = data.speed * 3.6
  }
  if (typeof data.velocity === 'number') {
    v.velocity = data.velocity
    v.speedKmh = data.velocity * 3.6
  }
  if (typeof data.altitude === 'number') {
    // Minecraft blocks ≈ meters — store as meters (mt)
    v.altitude = data.altitude
  }
  if (typeof data.vspeed === 'number') v.vspeed = data.vspeed
  if (typeof data.pitch === 'number') v.pitch = data.pitch
  if (typeof data.yaw === 'number') v.yaw = data.yaw
  if (typeof data.gforce === 'number') v.gforce = data.gforce
  if (typeof data.apogee === 'number') v.apogee = data.apogee
  if (typeof data.downrange === 'number') v.downrange = data.downrange
  if (Array.isArray(data.engines)) {
    v.engines = data.engines.map(Boolean)
    v.enginesLit = v.engines.filter(Boolean).length
    v.enginesTotal = v.engines.length
  }
  // Extended telemetry codes / sensors
  if (typeof data.fuelPct === 'number') v.fuelPct = Math.max(0, Math.min(100, data.fuelPct))
  if (typeof data.oxPct === 'number') v.oxPct = Math.max(0, Math.min(100, data.oxPct))
  if (typeof data.chamberPressure === 'number') v.chamberPressure = data.chamberPressure
  if (typeof data.throttle === 'number') v.throttle = Math.max(0, Math.min(100, data.throttle))
  if (typeof data.statusCode === 'number') v.statusCode = data.statusCode
  if (typeof data.statusText === 'string') v.statusText = String(data.statusText).slice(0, 32)
  if (typeof data.battery === 'number') v.battery = Math.max(0, Math.min(100, data.battery))
  if (typeof data.signal === 'number') v.signal = Math.max(0, Math.min(100, data.signal))
  if (typeof data.temp === 'number') v.temp = data.temp
  v.lastAt = Date.now()
}

function applyCmd(cmd, s, ws) {
  if (!s) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }))
    return
  }
  const action = cmd.action
  const role = s.role

  // Chat — everyone logged in
  if (action === 'chat') {
    const text = String(cmd.text || '').trim()
    if (!text) return
    const msg = pushChat(s.name, s.title, s.role, text)
    broadcast({ type: 'chat', msg })
    broadcastState()
    return
  }

  // Report a chat message — everyone
  if (action === 'chatReport') {
    const msgId = String(cmd.msgId || '')
    const target = chat.find((m) => m.id === msgId)
    if (!target) {
      ws.send(JSON.stringify({ type: 'error', message: 'Message not found' }))
      return
    }
    const report = {
      id: crypto.randomBytes(6).toString('hex'),
      msgId,
      by: s.name,
      title: s.title,
      reason: String(cmd.reason || 'Inappropriate').slice(0, 200),
      at: Date.now(),
      msgSnapshot: { name: target.name, text: target.text, at: target.at }
    }
    reports.push(report)
    if (reports.length > 100) reports.shift()
    pushLog(`${s.name} reported chat from ${target.name}`)
    broadcastState()
    return
  }

  // CEO: hide / dismiss reported message
  if (action === 'chatHide' || action === 'chatDelete') {
    if (!isCeo(s)) {
      ws.send(JSON.stringify({ type: 'error', message: 'CEO only' }))
      return
    }
    const msgId = String(cmd.msgId || '')
    if (action === 'chatDelete') {
      const before = chat.length
      chat = chat.filter((m) => m.id !== msgId)
      if (chat.length < before) pushLog(`${s.name} deleted chat message`)
    } else {
      const target = chat.find((m) => m.id === msgId)
      if (target) {
        target.hidden = true
        pushLog(`${s.name} hid chat message from ${target.name}`)
      }
    }
    reports = reports.filter((r) => r.msgId !== msgId)
    broadcastState()
    return
  }

  if (action === 'reportDismiss') {
    if (!isCeo(s)) {
      ws.send(JSON.stringify({ type: 'error', message: 'CEO only' }))
      return
    }
    reports = reports.filter((r) => r.id !== cmd.id)
    broadcastState()
    return
  }

  // Vote — everyone
  if (action === 'pollVote') {
    if (!poll || !poll.open) {
      ws.send(JSON.stringify({ type: 'error', message: 'No open poll' }))
      return
    }
    poll.votes[s.name] = cmd.vote === 'nogo' ? 'nogo' : 'go'
    pushLog(`${s.name} voted ${(cmd.vote === 'nogo' ? 'NO-GO' : 'GO')}`)
    broadcastState()
    return
  }

  // Requests — directors + admin + ceo
  if (action === 'requestHold' || action === 'requestAbort' || action === 'requestScrub') {
    const type = action === 'requestHold' ? 'hold' : action === 'requestAbort' ? 'abort' : 'scrub'
    // Scope: booster director → booster, ship director → starship, others → general
    let scope = 'general'
    if (role === 'booster_director') scope = 'booster'
    if (role === 'ship_director') scope = 'starship'
    if (cmd.scope === 'booster' || cmd.scope === 'starship') scope = cmd.scope
    const r = {
      id: crypto.randomBytes(6).toString('hex'),
      type, scope,
      by: s.name, title: s.title,
      at: Date.now(),
      note: String(cmd.note || '').slice(0, 160)
    }
    requests.push(r)
    pushLog(`${s.title} ${s.name}: REQUEST ${type.toUpperCase()} (${scope})`)
    broadcast({ type: 'request', request: r })
    broadcastState()
    return
  }

  // CEO only: full flight + polls + overlay + schedule + timeline
  if (action === 'resume' || action === 'hold' || action === 'abort' || action === 'reset' ||
      action === 'setT0' || action === 'setLabel' || action === 'pollCreate' || action === 'pollClose' || action === 'pollDelete' ||
      action === 'requestResolve' || action === 'setOverlayMode' || action === 'setWidgets' ||
      action === 'joinApprove' || action === 'joinDeny' || action === 'setFlightPlan' ||
      action === 'timelineSet' || action === 'timelineAdd' || action === 'timelineUpdate' || action === 'timelineDelete' || action === 'timelineReset' ||
      action === 'scheduleAdd' || action === 'scheduleUpdate' || action === 'scheduleDelete' ||
      action === 'scheduleLoad' || action === 'scheduleSetStatus' || action === 'scheduleApprove') {
    if (!isCeo(s)) {
      // Directors may execute HOLD/ABORT only for their scope via dedicated actions below
      if ((action === 'hold' || action === 'abort') && (role === 'booster_director' || role === 'ship_director')) {
        // allowed — scoped command
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'CEO only: ' + action }))
        log(`[deny] ${s.name} (${role}) → ${action}`)
        return
      }
    }
  }

  switch (action) {
    case 'resume':
      if (timer.aborted) break
      timer.hold = false
      timer.running = true
      timer.startTimestamp = Date.now()
      pushLog(`${s.name}: RESUME`)
      break
    case 'hold':
      timer.elapsedMs = currentElapsed()
      timer.running = false
      timer.hold = true
      pushLog(`${s.name}: HOLD`)
      break
    case 'abort':
      timer.elapsedMs = currentElapsed()
      timer.running = false
      timer.hold = false
      timer.aborted = true
      pushLog(`${s.name}: ABORT`)
      break
    case 'reset':
      timer.running = false
      timer.hold = false
      timer.aborted = false
      timer.elapsedMs = 0
      timer.startTimestamp = 0
      pushLog(`${s.name}: RESET`)
      break
    case 'setT0': {
      if (cmd.iso) {
        const t0 = Date.parse(cmd.iso)
        if (!Number.isNaN(t0)) {
          timer.t0Utc = t0
          const delta = t0 - Date.now()
          if (delta > 0) {
            timer.mode = 'down'
            timer.totalMs = delta
            timer.elapsedMs = 0
            timer.running = true
            timer.hold = false
            timer.aborted = false
            timer.startTimestamp = Date.now()
          } else {
            timer.mode = 'up'
            timer.elapsedMs = -delta
            timer.running = true
            timer.hold = false
            timer.aborted = false
            timer.startTimestamp = Date.now()
          }
          pushLog(`${s.name}: T-0 set ${new Date(t0).toISOString()}`)
        }
      }
      break
    }
    case 'setLabel':
      timer.label = String(cmd.label || '').slice(0, 48)
      pushLog(`${s.name}: label → ${timer.label}`)
      break
    case 'setOverlayMode': {
      const allowed = ['auto', 'countdown', 'full', 'booster', 'ship']
      const mode = String(cmd.mode || '').toLowerCase()
      if (allowed.includes(mode)) {
        overlayMode = mode
        pushLog(`${s.name}: overlay → ${mode}`)
      }
      break
    }
    case 'setWidgets': {
      const incoming = cmd.widgets || {}
      const keys = ['timeline', 'boosterEngines', 'shipEngines', 'gauges', 'cornerClock']
      for (const k of keys) {
        if (typeof incoming[k] === 'boolean') widgets[k] = incoming[k]
      }
      pushLog(`${s.name}: widgets updated`)
      break
    }
    case 'joinApprove': {
      const result = approveJoin(String(cmd.id || ''))
      if (result) {
        pushLog(`${s.name}: approved join ${result.name} (${result.title})`)
        broadcast({ type: 'joinApproved', pendingId: result.pendingId, token: result.token, role: result.role, name: result.name, title: result.title })
      }
      break
    }
    case 'joinDeny': {
      if (denyJoin(String(cmd.id || ''))) {
        pushLog(`${s.name}: denied a join request`)
        broadcast({ type: 'joinDenied', pendingId: String(cmd.id || '') })
      }
      break
    }
    case 'setFlightPlan': {
      const b = String(cmd.booster || '').toLowerCase()
      const sh = String(cmd.ship || '').toLowerCase()
      if (b === 'catch' || b === 'splashdown') flightPlan.booster = b
      if (sh === 'catch' || sh === 'splashdown') flightPlan.ship = sh
      const labels = {
        'catch|catch': 'Double catch',
        'catch|splashdown': 'Booster catch · Ship splashdown',
        'splashdown|catch': 'Booster splashdown · Ship catch',
        'splashdown|splashdown': 'Double splashdown'
      }
      flightPlan.label = labels[flightPlan.booster + '|' + flightPlan.ship] || 'Custom'
      pushLog(`${s.name}: flight plan → ${flightPlan.label}`)
      break
    }
    case 'timelineSet': {
      // Replace entire timeline (array of { key, label, pos, t })
      const list = Array.isArray(cmd.events) ? cmd.events : []
      timelineEvents = list.slice(0, 80).map((e, i) => ({
        id: String(e.id || ('tl' + crypto.randomBytes(4).toString('hex'))),
        key: String(e.key || e.label || 'EVENT').replace(/\s+/g, '_').toUpperCase().slice(0, 40),
        label: String(e.label || 'EVENT').slice(0, 48),
        pos: e.pos === 'above' ? 'above' : 'below',
        t: Number(e.t) || 0
      })).sort((a, b) => a.t - b.t)
      pushLog(`${s.name}: timeline set (${timelineEvents.length} events)`)
      break
    }
    case 'timelineAdd': {
      const e = cmd.event || cmd
      const id = 'tl' + crypto.randomBytes(4).toString('hex')
      timelineEvents.push({
        id,
        key: String(e.key || e.label || 'EVENT').replace(/\s+/g, '_').toUpperCase().slice(0, 40),
        label: String(e.label || 'EVENT').slice(0, 48),
        pos: e.pos === 'above' ? 'above' : 'below',
        t: Number(e.t) || 0
      })
      timelineEvents.sort((a, b) => a.t - b.t)
      pushLog(`${s.name}: timeline + ${e.label || id}`)
      break
    }
    case 'timelineUpdate': {
      const id = String(cmd.id || '')
      const idx = timelineEvents.findIndex(x => x.id === id)
      if (idx >= 0) {
        const e = timelineEvents[idx]
        if (cmd.label != null) e.label = String(cmd.label).slice(0, 48)
        if (cmd.key != null) e.key = String(cmd.key).replace(/\s+/g, '_').toUpperCase().slice(0, 40)
        if (cmd.pos != null) e.pos = cmd.pos === 'above' ? 'above' : 'below'
        if (cmd.t != null && !Number.isNaN(Number(cmd.t))) e.t = Number(cmd.t)
        timelineEvents.sort((a, b) => a.t - b.t)
        pushLog(`${s.name}: timeline edit ${e.label}`)
      }
      break
    }
    case 'timelineDelete': {
      const id = String(cmd.id || '')
      const before = timelineEvents.length
      timelineEvents = timelineEvents.filter(x => x.id !== id)
      if (timelineEvents.length < before) pushLog(`${s.name}: timeline removed event`)
      break
    }
    case 'timelineReset': {
      timelineEvents = DEFAULT_TIMELINE.map((e, i) => ({
        id: 'tl' + i + '_' + crypto.randomBytes(2).toString('hex'),
        key: e.key,
        label: e.label,
        pos: e.pos === 'above' ? 'above' : 'below',
        t: Number(e.t) || 0
      }))
      pushLog(`${s.name}: timeline reset to defaults`)
      break
    }
    case 'setAvailability': {
      // Any logged-in user can set their own availability
      const slots = Array.isArray(cmd.slots) ? cmd.slots : []
      const clean = slots.slice(0, 80).map(s => ({
        day: Math.max(0, Math.min(6, Number(s.day) || 0)),
        start: Math.max(0, Math.min(1439, Number(s.start) || 0)),
        end: Math.max(1, Math.min(1440, Number(s.end) || 60))
      })).filter(s => s.end > s.start)
      const key = (s.name + '|' + s.role).toLowerCase()
      availability[key] = {
        name: s.name,
        title: s.title,
        role: s.role,
        tz: String(cmd.tz || 'UTC').slice(0, 64),
        slots: clean,
        updatedAt: Date.now()
      }
      pushLog(`${s.name}: availability updated (${clean.length} slots)`)
      break
    }
    case 'setVehicleProgram': {
      // CEO only — switch between Starship stack and Eclipse (Falcon 9)
      if (!isCeo(s)) {
        ws.send(JSON.stringify({ type: 'error', message: 'CEO only' }))
        return
      }
      const prog = String(cmd.program || '').toLowerCase()
      if (prog === 'starship' || prog === 'eclipse') {
        vehicleProgram = prog
        vehicle = resetVehicleForProgram(prog)
        const meta = PROGRAMS[prog]
        timer.label = meta.defaultLabel
        pushLog(`${s.name}: vehicle program → ${meta.name}`)
      }
      break
    }
    case 'pollCreate': {
      const prog = PROGRAMS[vehicleProgram] || PROGRAMS.starship
      const stations = Array.isArray(cmd.stations)
        ? cmd.stations.map(String).slice(0, 12)
        : prog.pollStations
      poll = {
        id: crypto.randomBytes(8).toString('hex'),
        title: String(cmd.title || 'GO / NO-GO').slice(0, 80),
        stations, open: true, createdBy: s.name, createdAt: Date.now(), votes: {}
      }
      pushLog(`${s.name}: poll opened — ${poll.title}`)
      break
    }
    case 'pollClose':
      if (poll) { poll.open = false; pushLog(`${s.name}: poll closed`) }
      break
    case 'pollDelete':
      if (poll) {
        pushLog(`${s.name}: poll deleted (${poll.title})`)
        poll = null
      }
      break
    case 'requestResolve':
      requests = requests.filter((r) => r.id !== cmd.id)
      break
    case 'scheduleAdd': {
      // New entries start in PLANNING. Optional iso; can be set later.
      let t0 = null
      if (cmd.iso) {
        const parsed = Date.parse(cmd.iso)
        if (!Number.isNaN(parsed)) t0 = parsed
      }
      const entry = {
        id: crypto.randomBytes(6).toString('hex'),
        name: String(cmd.name || 'Flight Test').trim().slice(0, 64) || 'Flight Test',
        vehicle: String(cmd.vehicle || 'Starship').trim().slice(0, 32) || 'Starship',
        t0Utc: t0,
        status: 'planning',
        note: String(cmd.note || '').trim().slice(0, 160),
        createdBy: s.name,
        createdAt: Date.now()
      }
      schedule.push(entry)
      pushLog(`${s.name}: PLANNING + ${entry.name}` + (t0 ? ` @ ${new Date(t0).toISOString()}` : ''))
      break
    }
    case 'scheduleUpdate': {
      const id = String(cmd.id || '')
      const entry = schedule.find((e) => e.id === id)
      if (!entry) {
        ws.send(JSON.stringify({ type: 'error', message: 'Schedule entry not found' }))
        return
      }
      if (cmd.name != null) entry.name = String(cmd.name).trim().slice(0, 64) || entry.name
      if (cmd.vehicle != null) entry.vehicle = String(cmd.vehicle).trim().slice(0, 32) || entry.vehicle
      if (cmd.note != null) entry.note = String(cmd.note).trim().slice(0, 160)
      if (cmd.iso) {
        const t0 = Date.parse(cmd.iso)
        if (!Number.isNaN(t0)) entry.t0Utc = t0
      }
      if (cmd.status && SCHEDULE_STATUSES.includes(cmd.status)) {
        // Only CEO can approve
        if (cmd.status === 'approved' && !isCeo(s)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Only CEO can approve launches' }))
          return
        }
        entry.status = cmd.status
      }
      pushLog(`${s.name}: schedule updated ${entry.name}`)
      break
    }
    case 'scheduleDelete': {
      const id = String(cmd.id || '')
      const before = schedule.length
      schedule = schedule.filter((e) => e.id !== id)
      if (schedule.length < before) pushLog(`${s.name}: schedule entry deleted`)
      break
    }
    case 'scheduleSetStatus': {
      const id = String(cmd.id || '')
      const entry = schedule.find((e) => e.id === id)
      if (!entry) {
        ws.send(JSON.stringify({ type: 'error', message: 'Schedule entry not found' }))
        return
      }
      const st = String(cmd.status || '')
      if (!SCHEDULE_STATUSES.includes(st)) break
      // Only CEO can set APPROVED
      if (st === 'approved' && !isCeo(s)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only CEO can approve launches' }))
        return
      }
      entry.status = st
      pushLog(`${s.name}: schedule ${entry.name} → ${st.toUpperCase()}`)
      break
    }
    case 'scheduleApprove': {
      // Explicit CEO-only approve action
      if (!isCeo(s)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only CEO can approve launches' }))
        return
      }
      const id = String(cmd.id || '')
      const entry = schedule.find((e) => e.id === id)
      if (!entry) {
        ws.send(JSON.stringify({ type: 'error', message: 'Schedule entry not found' }))
        return
      }
      entry.status = 'approved'
      pushLog(`${s.name}: APPROVED ${entry.name}`)
      break
    }
    case 'scheduleLoad': {
      // Load an approved/scheduled launch into the active countdown / T-0
      const id = String(cmd.id || '')
      const entry = schedule.find((e) => e.id === id)
      if (!entry) {
        ws.send(JSON.stringify({ type: 'error', message: 'Schedule entry not found' }))
        return
      }
      if (!entry.t0Utc) {
        ws.send(JSON.stringify({ type: 'error', message: 'Set a T-0 time before loading' }))
        return
      }
      const t0 = entry.t0Utc
      timer.t0Utc = t0
      timer.label = entry.name.slice(0, 48)
      const delta = t0 - Date.now()
      if (delta > 0) {
        timer.mode = 'down'
        timer.totalMs = delta
        timer.elapsedMs = 0
        timer.running = true
        timer.hold = false
        timer.aborted = false
        timer.startTimestamp = Date.now()
      } else {
        timer.mode = 'up'
        timer.elapsedMs = -delta
        timer.running = true
        timer.hold = false
        timer.aborted = false
        timer.startTimestamp = Date.now()
      }
      // Promote to scheduled when loaded into countdown
      if (entry.status === 'planning' || entry.status === 'approved') {
        entry.status = 'scheduled'
      }
      pushLog(`${s.name}: LOADED ${entry.name} → T-0 ${new Date(t0).toISOString()}`)
      break
    }
    default:
      return
  }
  broadcastState()
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true
  ws.token = null
  ws.clientKind = 'ui'
  ws.on('pong', () => { ws.isAlive = true })

  const url = (req.url || '/').split('?')[0]
  const ip = req.socket.remoteAddress

  // ComputerCraft telemetry sockets
  // Stage 1 aliases: booster / stage1 / falcon1 / eclipse1
  if (url === '/telemetry/booster' || url === '/stage1' || url === '/booster' ||
      url === '/telemetry/falcon1' || url === '/telemetry/eclipse1' || url === '/falcon1') {
    ws.clientKind = 'cc-booster'
    log(`[cc] stage1/booster connected ${ip}`)
    ws.on('message', (raw) => {
      ws.isAlive = true
      try {
        const data = JSON.parse(raw)
        applyTelemetry('booster', data)
        broadcastState()
      } catch {}
    })
    ws.on('close', () => log(`[cc] stage1/booster disconnected`))
    return
  }
  // Stage 2 aliases: starship / stage2 / falcon2 / eclipse2
  if (url === '/telemetry/starship' || url === '/starship' || url === '/stage2' ||
      url === '/telemetry/falcon2' || url === '/telemetry/eclipse2' || url === '/falcon2') {
    ws.clientKind = 'cc-starship'
    log(`[cc] stage2/starship connected ${ip}`)
    ws.on('message', (raw) => {
      ws.isAlive = true
      try {
        const data = JSON.parse(raw)
        applyTelemetry('starship', data)
        broadcastState()
      } catch {}
    })
    ws.on('close', () => log(`[cc] stage2/starship disconnected`))
    return
  }

  log(`[ws] ui connect ${ip}`)
  ws.send(JSON.stringify(snapshot()))

  ws.on('message', (raw) => {
    ws.isAlive = true
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }))
      return
    }
    if (msg.type === 'auth') {
      const s = sess(msg.token)
      if (s) {
        ws.token = msg.token
        ws.role = s.role
        ws.sessName = s.name
        ws.send(JSON.stringify({ type: 'auth_ok', role: s.role, name: s.name, title: s.title }))
        ws.send(JSON.stringify(snapshot()))
        log(`[auth] ${s.name} (${s.role})`)
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail' }))
      }
      return
    }
    // Legacy telemetry push from UI bridge
    if (msg.type === 'telemetry') {
      applyTelemetry(msg.side === 'starship' ? 'starship' : 'booster', msg.data)
      broadcastState()
      return
    }
    if (msg.type === 'cmd') {
      applyCmd(msg, sess(ws.token), ws)
    }
  })

  ws.on('close', () => log(`[ws] disconnect ${ip}`))
})

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate()
    ws.isAlive = false
    try { ws.ping() } catch {}
  })
}, 15000)

setInterval(broadcastState, 500)

server.listen(PORT, HOST, () => {
  log(`Mission Control on http://${HOST}:${PORT}`)
  log(`  Panel:  http://localhost:${PORT}/panel`)
  log(`  Stream: http://localhost:${PORT}/stream`)
  log(`  Propellant: http://localhost:${PORT}/propellant`)
  log(`  Flight Plan: http://localhost:${PORT}/flight-plan`)
  log(`  Starting Soon (OBS scene): http://localhost:${PORT}/starting-soon`)
  log(`  Loss of Signal (OBS scene): http://localhost:${PORT}/loss-of-signal`)
  log(`  CC stage1:   ws://<server-ip>:${PORT}/telemetry/booster  (also /stage1 /falcon1 /eclipse1)`)
  log(`  CC stage2:   ws://<server-ip>:${PORT}/telemetry/starship (also /stage2 /falcon2 /eclipse2)`)
  log(`  Programs:    starship | eclipse (Falcon 9) — CEO switcher in panel`)
  log(`Passwords: CEO ISA-Peak-2026!Sys | CEO2 ISA-KZ-Peak-2026! | Booster Booster-Dir-2026! | Admin ISA-Admin-2026!`)
})
