# Mission Control v4

## Start
```bash
npm install
node server.js
```
- Panel: http://localhost:5105/panel  
- Stream: http://localhost:5105/stream  
- Propellant (OBS scene): http://localhost:5105/propellant  
- Starting Soon (OBS scene): http://localhost:5105/starting-soon  
- Loss of Signal (OBS scene): http://localhost:5105/loss-of-signal  

**Login:** any display name + role password (passwords are NOT shown in the UI).

| Role | Password |
|------|----------|
| CEO | `ISA-Peak-2026!Sys` |
| CEO | `ISA-KZ-Peak-2026!` |
| Booster Director | `Booster-Dir-2026!` |
| Ship Director | `Ship-Dir-2026!` |
| Admin | `ISA-Admin-2026!` |

Keep this file private — do not share passwords in the panel UI.

## Features
- Free display names, server-side roles
- Polls, chat, reports, CEO delete
- ComputerCraft telemetry (meters / mt) with extended **telemetry codes**
- Stream overlay for OBS
- CEO-selectable stream overlay layouts (Auto / Countdown / Full / Stage1 engines / Stage2 engines)
- **Vehicle program switcher (CEO)** — switch between:
  - **Starship** — Super Heavy (33 eng) + Starship (6 eng)
  - **Eclipse (Falcon 9)** — Stage 1 (9 Merlin) + Stage 2 (1 Merlin Vac)
- Labels, engine counts, poll stations and overlay engine rings update automatically
- Two standalone full-screen OBS scene pages — **Starting Soon** and **Loss of Signal**
- **Launch Schedule** — CEO can add planned launches (name, vehicle, T-0, note), load one into the active countdown, mark scrubbed/completed, or delete
- **Propellant Load page** (`/propellant`) — standalone OBS scene for Starship + Booster CH4 / LOX tanks
  - Linked to countdown: **0% at T−30:00 → fully loaded (100%) at T−03:00** (linear)
  - Driven purely by the countdown timer; `?scale=1.6` resizes the widget
- Stream bar scale fix — stable resize (center-bottom origin, no stretch above 1×, debounced)

- **Flight Plan page** (`/flight-plan`, also `/fp`, `/trajectory`) — standalone OBS scene, line-art Starship V3 + Super Heavy on a realistic ascent / hot-staging / boostback / orbit / deorbit / entry / landing profile
  - Driven by the countdown timer (T+ clock moves the vehicles); recovery (catch / splashdown) follows the CEO's Flight Plan setting in the panel
  - Params: `?demo=1&speed=60` loop preview, `?t=SECONDS` freeze a moment, `?plan=catch,splashdown` force booster,ship, `?bg=transparent`

## Telemetry codes (extended sensors)
Both stages accept / report:
- `fuelPct`, `oxPct`, `throttle` (0–100)
- `chamberPressure` (bar)
- `statusCode` (number) + `statusText` (string, e.g. NOMINAL)
- `battery`, `signal` (0–100)
- `temp`
- classic: `speed`, `altitude`, `vspeed`, `pitch`, `yaw`, `gforce`, `engines[]`

## ComputerCraft
`computercraft/` scripts — set `HOST` to server IP.

| Script | Vehicle | Endpoint |
|--------|---------|----------|
| `startup-booster.lua` | Super Heavy / Stage 1 | `/telemetry/booster` (also `/stage1`) |
| `startup-starship.lua` | Starship / Stage 2 | `/telemetry/starship` (also `/stage2`) |
| `startup-eclipse-stage1.lua` | Falcon 9 Stage 1 | `/telemetry/falcon1` (also `/eclipse1`) |
| `startup-eclipse-stage2.lua` | Falcon 9 Stage 2 | `/telemetry/falcon2` (also `/eclipse2`) |

All stage-1 aliases map to the same internal “booster” slot; stage-2 aliases map to “starship”.  
Switch the **Vehicle program** in the panel (CEO → Stream tab) so labels and engine counts match what you are flying.
