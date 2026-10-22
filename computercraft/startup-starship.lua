-- Starship → Mission Control server

local HOST = "127.0.0.1"   -- change to your server LAN IP
local PORT = 5105
local SERVER = "ws://" .. HOST .. ":" .. PORT .. "/telemetry/starship"

local CONFIG = {
  leftSide = "left",    -- sea-level
  rightSide = "right",  -- vacuum
  seaLevelCount = 3,
  vacuumCount = 3,
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
          chamberPressure = 300,
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
  local lastLeft, lastRight = nil, nil
  while true do
    pcall(function()
      local leftActive = redstone.getInput(CONFIG.leftSide)
      local rightActive = redstone.getInput(CONFIG.rightSide)
      if leftActive ~= lastLeft or rightActive ~= lastRight then
        local engines = {}
        for i = 1, CONFIG.seaLevelCount do engines[i] = leftActive end
        for i = 1, CONFIG.vacuumCount do engines[CONFIG.seaLevelCount + i] = rightActive end
        send(textutils.serialiseJSON({ engines = engines }))
        lastLeft, lastRight = leftActive, rightActive
        print("[engines] SL=" .. tostring(leftActive) .. " VAC=" .. tostring(rightActive))
      end
    end)
    os.pullEvent("redstone")
  end
end

print("[boot] starship → " .. SERVER)
connect()
parallel.waitForAll(telemetryLoop, engineLoop)
