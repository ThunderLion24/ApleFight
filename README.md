# ApleFight

Battle royale for 20–50 players (bots count) that runs in the browser. Everyone rides a plane over a 360 m island, jumps out, smashes crates, trees and rocks for building materials, and fights until one player is left. Crates, barrels, bouncy giant apples and ragdolls are all real rigid bodies (cannon-es), rendered with three.js.

## Match types

The match type is decided when each match starts, from how many players (people plus bots) are in the room. A room holds at most 50.

| Players | Match | Lives | Winner |
|---|---|---|---|
| 20–50 | Battle royale | One | Last one alive. The storm closes completely about 7 minutes after the drop, so matches run roughly 5–8 minutes. |
| Fewer than 20 | Respawn match | Infinite: you skydive back in 3 s after dying | Most kills when the 7-minute clock runs out. Played inside a fixed circle around the centre (5 damage/s outside). Broken items grow back after 45 s. |

If a respawn match reaches 20 players, it ends early and the next match is a battle royale.

## How a match works

1. **Lobby:** a short countdown (8 s) while players and bots gather.
2. **Plane:** the plane crosses the island on a random line (shown on the minimap). Press **Space** over the island to jump; anyone still aboard is pushed out at the far edge.
3. **Drop:** you freefall (WASD steers, look down to dive faster), and a glider opens about 25 m above the ground. From the flight line you can glide roughly 170 m.
4. **Harvest and build:** you land with 0 materials, and they don't regenerate. Break things to get them: tree 40, rock 60, crate 20, big crate 45, barrel 30. The pickaxe is the fastest way; guns only do a quarter of their damage to these, and explosions count too. Whoever breaks an item gets its materials.
5. **Storm (battle royale):** after the drop, the storm circle shrinks in five stages and hurts anyone outside it (1 to 8 damage per second). The next circle shows as a dashed ring on the minimap.
6. **One life (battle royale):** when you're eliminated, you spectate (click to switch players). Anyone who joins after the plane has left watches until the next match.

The island has the original arena in the middle plus 16 more places to land (villages, container yards, forts and watchtowers), about 270 trees (some in forests) and 110 rocks.

Bots harvest and avoid fights for the first few minutes of a battle royale, then fight from further away as the match goes on. They always shoot back when hit.

## Play

| Mode | How |
|---|---|
| **Practice** | Open `index.html` in a browser, pick Practice, choose how many bots and how hard. No server needed. |
| **Host (peer-to-peer)** | Pick Host. You get a 4-letter room code. Your browser runs the match, so keep the tab open. |
| **Join (peer-to-peer)** | Pick Join and type the host's code. Connections go through the free PeerJS broker (`0.peerjs.com`), with PeerJS's TURN relays as a fallback. |
| **Server** | `npm install && npm start`, then open `http://localhost:8080` and pick Server. Everyone who enters the same room code plays together. The first player in a room owns it and can add bots. Set `PORT` to change the port. |

Bots can be added or removed in any mode from the pause menu (Esc) by the room owner.

## Controls

| Key | Action |
|---|---|
| WASD, Mouse | Move, aim |
| Left click / Right click | Shoot / zoom |
| Space, Shift | Jump, sprint |
| Q / E | Lean left / right (peek around corners; blocked by walls) |
| R | Reload (rotates stairs while building) |
| Space (in the plane) | Jump out |
| 1 / F | Pickaxe (harvest materials) |
| 2 3 4, Wheel | Rifle, Shotgun, Apple Launcher |
| Z X C V | Build wall / floor / stairs / cone (press again to stop) |
| G | Edit one of your builds: click or drag tiles to cut them out, G or Enter to confirm, right-click to reset |
| Tab | Players (alive / placement) |
| Click (while eliminated) | Spectate the next player |
| Esc | Pause menu, bots, settings |

Builds snap to a 3 m grid, cost 10 materials, have hit points, and break when shot, hit with the pickaxe or blown up. You can only build after landing.

## Files

- `index.html` – the client: rendering, HUD, menus, networking.
- `sim.js` – the shared game simulation (physics, weapons, bots, building). The same file runs in the browser and on the server.
- `server.js` – optional dedicated server (serves the page and runs rooms over WebSockets).

## Limits

- Peer-to-peer and server play have no client-side movement prediction, so on a slow connection your own movement lags by your ping.
- If a host's tab closes, their peer-to-peer game ends.
