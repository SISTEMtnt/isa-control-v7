-- Eclipse / Falcon 9 Stage 1 → Mission Control server
-- 9 Merlin engines

local HOST = "127.0.0.1"   -- change to your server LAN IP
local PORT = 5105
local SERVER = "ws://" .. HOST .. ":" .. PORT .. "/telemetry/falcon1"

local CONFIG = {
  engineSide = "left",
  engineCount = 9,
}

local GRAVITY = 9.8
local lastVelocity, lastClock = nil, nil

local function computeGForce(velocity)
  local now = os.epoch("utc") / 1000
  if not lastVelocity or not lastClock then
    lastVelocity, lastClock = velocity, now
    return 0
  end
  local dt = now - lastClock
  lastClock = now
  if dt <= 0 or dt > 1 then lastVelocity = velocity return 0 end
  local ax = (velocity.x - lastVelocity.x) / dt
  local ay = (velocity.y - lastVelocity.y) / dt + GRAVITY
  local az = (velocity.z - lastVelocity.z) / dt
  lastVelocity = velocity
  local g = math.sqrt(ax*ax + ay*ay + az*az) / GRAVITY
  if g ~= g or g == math.huge or g > 25 then return 0 end
  return g
end

local ws, connecting, backoff = nil, false, 1

local function connect()
  if connecting then
    while connecting and not ws do sleep(0.1) end
    return
  end
  connecting = true
  ws = nil
  while true do
    local socket, err = http.websocket(SERVER)
    if socket then
      ws = socket
      backoff = 1
      print("[ok] connected " .. SERVER)
      connecting = false
      return
    end
    print("[retry] " .. tostring(err) .. " wait " .. backoff .. "s")
    sleep(backoff)
    backoff = math.min(backoff * 1.6, 12)
  end
end

local function send(payload)
  if not ws then connect() end
  local ok = pcall(function() ws.send(payload) end)
  if not ok then
    pcall(function() if ws then ws.close() end end)
    ws = nil
    connect()
    pcall(function() ws.send(payload) end)
  end
end

local function readPose()
  for _ = 1, 4 do
    local ok, pose, velocity = pcall(function()
      return sublevel.getLogicalPose(), sublevel.getVelocity()
    end)
    if ok and pose and velocity then return pose, velocity end
    sleep(0.04)
  end
  return nil, nil
end

local function telemetryLoop()
  while true do
    local pose, velocity = readPose()
    if pose and velocity then
      pcall(function()
        local pitchRad, yawRad = pose.orientation:toEuler()
        send(textutils.serialiseJSON({
          speed = velocity:length(),
          altitude = pose.position.y,
          vspeed = velocity.y,
          pitch = math.deg(pitchRad),
          yaw = math.deg(yawRad),
          gforce = computeGForce(velocity),
          -- Telemetry codes
          fuelPct = 100,
          oxPct = 100,
          throttle = 100,
          chamberPressure = 97,
          statusCode = 0,
          statusText = "NOMINAL",
          battery = 100,
          signal = 100,
          temp = 25,
        }))
      end)
    end
    sleep(0.05)
  end
end

local function engineLoop()
  local lastActive = nil
  while true do
    pcall(function()
      local active = redstone.getInput(CONFIG.engineSide)
      if active ~= lastActive then
        local engines = {}
        for i = 1, CONFIG.engineCount do engines[i] = active end
        send(textutils.serialiseJSON({ engines = engines }))
        lastActive = active
        print("[engines] " .. tostring(active))
      end
    end)
    os.pullEvent("redstone")
  end
end

print("[boot] eclipse stage1 → " .. SERVER)
connect()
parallel.waitForAll(telemetryLoop, engineLoop)
