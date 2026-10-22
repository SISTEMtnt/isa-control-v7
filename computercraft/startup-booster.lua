-- Super Heavy / Booster → Mission Control server
-- Edit HOST to your PC IP (LAN) or use 127.0.0.1 if CC is on same machine via bridge

local HOST = "127.0.0.1"   -- change to your server LAN IP, e.g. "192.168.1.42"
local PORT = 5105
local SERVER = "ws://" .. HOST .. ":" .. PORT .. "/telemetry/booster"

-- Engine groups, each driven by its own redstone side.
-- Order in the engines[] array sent to the server: front, back, left, right.
local CONFIG = {
  frontSide = "front", frontCount = 3,   -- 3 gimbaling centre engines
  backSide  = "back",  backCount  = 2,   -- 2 engines that help on descent
  leftSide  = "left",  leftCount  = 10,  -- central ring of 10 (not the 5 above)
  rightSide = "right", rightCount = 18,  -- outer engines (33 - 3 - 2 - 10)
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
  local last = {}
  local groups = {
    { CONFIG.frontSide, CONFIG.frontCount, "FRONT" },
    { CONFIG.backSide,  CONFIG.backCount,  "BACK"  },
    { CONFIG.leftSide,  CONFIG.leftCount,  "LEFT"  },
    { CONFIG.rightSide, CONFIG.rightCount, "RIGHT" },
  }
  while true do
    pcall(function()
      local states, changed = {}, false
      for i, g in ipairs(groups) do
        states[i] = redstone.getInput(g[1])
        if states[i] ~= last[i] then changed = true end
      end
      if changed then
        local engines, n = {}, 0
        for i, g in ipairs(groups) do
          for _ = 1, g[2] do n = n + 1; engines[n] = states[i] end
        end
        send(textutils.serialiseJSON({ engines = engines }))
        last = states
        print(string.format("[engines] F=%s B=%s L=%s R=%s",
          tostring(states[1]), tostring(states[2]), tostring(states[3]), tostring(states[4])))
      end
    end)
    os.pullEvent("redstone")
  end
end

print("[boot] booster → " .. SERVER)
connect()
parallel.waitForAll(telemetryLoop, engineLoop)
