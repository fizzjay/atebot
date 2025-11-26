const { attConfig } = require('./config2');
const { Client: attClient } = require('att-client');
const attbot = new attClient(attConfig);

let activeConnection = null;
let reconnectTimeout = null;

const GESTURE_COOLDOWN = 5000;
const lastGestureTime = {};
const gesturesEnabled = {};
const travelButtons = {};
const buttonCooldowns = {};
const socialButtons = {};
const socialCooldowns = {};
const authorizedUsers = new Set(); // Users who picked up smelter gem 1

function scheduleReconnect() {
  if (reconnectTimeout) return;
  console.log('[GESTURE BOT] Attempting reconnect in 5 seconds...');
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    startBot();
  }, 5000);
}

async function startBot() {
  try {
    await attbot.start();
  } catch (err) {
    console.error('[GESTURE BOT] Failed to start:', err);
    scheduleReconnect();
  }
}

attbot.on('connect', async connection => {
  console.log(`[GESTURE BOT] Connected to ${connection.server.name}`);
  
  activeConnection = connection;

  // Startup animation
  async function startupAnimation() {
    try {
      await new Promise(r => setTimeout(r, 1000));
      
      await activeConnection.send(`player message "*" "----------------" 3`);
      await new Promise(r => setTimeout(r, 400));

      const phases = [
        "/---------------", "//--------------", "///-------------", "////------------",
        "/////----------", "//////----------", "///////---------", "////////--------",
        "/////////-------", "//////////------", "///////////-----", "////////////----",
        "/////////////---", "//////////////--", "///////////////-", "////////////////",
      ];

      for (const phase of phases) {
        await activeConnection.send(`player message "*" "${phase}" 1`);
        await new Promise(r => setTimeout(r, 300));
      }

      const explosionFrames = [
        "       /        /       /      ", "   /       /         /         ",
        "         /                /    ", " /            /                ",
        "                  /       /    ", "      /                        ",
        "                /         /    ", "  /        /                   ",
        "              /          /     ", "    /                     /    ",
      ];

      for (const frame of explosionFrames) {
        await activeConnection.send(`player message "*" "${frame}" 1`);
        await new Promise(r => setTimeout(r, 200));
      }

      const convergeFrames = [
        "   /     /     /     /     /   ", "     /    /   /    /    /      ",
        "       /   / / /   /           ", "         / /// /               ",
        "          /////                ", "           |||                 ",
        "           |||                 ", "         |online|              ",
      ];

      for (const frame of convergeFrames) {
        await activeConnection.send(`player message "*" "${frame}" 1`);
        await new Promise(r => setTimeout(r, 300));
      }

      await new Promise(r => setTimeout(r, 500));
      await activeConnection.send(`player message "*" "|online|" 3`);
      
    } catch (err) {
      console.error('[STARTUP ERROR]', err);
    }
  }

  await startupAnimation();

  connection.on('close', () => {
    console.log('[GESTURE BOT] Connection closed.');
    activeConnection = null;
    scheduleReconnect();
  });

  connection.on('error', err => {
    console.error('[GESTURE BOT] Connection error:', err);
    activeConnection = null;
    scheduleReconnect();
  });

  function getDistance(x1, y1, z1, x2, y2, z2) {
    return Math.sqrt(
      Math.pow(x2 - x1, 2) +
      Math.pow(y2 - y1, 2) +
      Math.pow(z2 - z1, 2)
    );
  }

  function detectHandOrientation(up) {
    if (up[1] > 0.5) return "Down";
    else if (up[1] < -0.5) return "Up";
    else return "Sideways";
  }

  async function checkHandGestures(username, leftUp, rightUp, leftHand, rightHand, maxDistance = 0.15) {
    const leftOrientation = detectHandOrientation(leftUp);
    const rightOrientation = detectHandOrientation(rightUp);
    
    const handDistance = getDistance(
      leftHand[0], leftHand[1], leftHand[2],
      rightHand[0], rightHand[1], rightHand[2]
    );

    const handsTogether = handDistance <= maxDistance;

    if (!handsTogether) return null;

    if (rightOrientation === "Down" && leftOrientation === "Up") {
      return 'replace';
    }

    if (leftOrientation === "Down" && rightOrientation === "Up") {
      return 'delete';
    }

    return null;
  }

  function checkFaceGestures(username, leftUp, rightUp, leftHand, rightHand, headPos, maxDistance = 0.3) {
    const leftOrientation = detectHandOrientation(leftUp);
    const rightOrientation = detectHandOrientation(rightUp);
    
    const leftToHead = getDistance(
      leftHand[0], leftHand[1], leftHand[2],
      headPos[0], headPos[1], headPos[2]
    );
    
    const rightToHead = getDistance(
      rightHand[0], rightHand[1], rightHand[2],
      headPos[0], headPos[1], headPos[2]
    );

    if (leftToHead <= maxDistance && rightToHead <= maxDistance) {
      return 'toggle';
    }

    if (rightToHead <= maxDistance && rightOrientation === "Down") {
      return 'damage';
    }

    if (leftToHead <= maxDistance && leftOrientation === "Down") {
      return 'speed';
    }

    if (rightToHead <= maxDistance && rightOrientation === "Up") {
      return 'hunger';
    }

    if (leftToHead <= maxDistance && leftOrientation === "Up") {
      return 'godmode';
    }

    return null;
  }

  // ==================== ARROW SYSTEM START ====================
  let activeArrows = [];
  
  // Charged arrow states
  let chargedSpeedArrow = false, speedArrowId = null;
  let chargedKillArrow = false, killArrowId = null;
  let chargedDarkArrow = false, darkArrowId = null;
  let chargedTeleportArrow = false, teleportArrowId = null;

  function distance3D(pos1, pos2) {
    const dx = pos1[0] - pos2[0];
    const dy = pos1[1] - pos2[1];
    const dz = pos1[2] - pos2[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Subscribe to inventory changes to detect arrow shots
  connection.subscribe('InventoryChanged', async (event) => {
    try {
      const invUser = event.data.User;
      const username = invUser?.username;
      if (!username) return;

      const changeType = (event.data.ChangeType || '').toLowerCase();
      const itemName = (event.data.ItemName || '').toLowerCase();

      // Check for smelter gem 1 pickup - authorize for gestures
      if (changeType === "pickup" && itemName.includes("smelter gem 1")) {
        authorizedUsers.add(username);
        await activeConnection.send(`player message "${username}" "✅ Gestures unlocked! You can now use hand gestures." 3`);
        console.log(`[AUTHORIZED] ${username} picked up Smelter Gem 1 - gestures enabled`);
        return;
      }

      // Get inventory data
      let inv = event.data.Inventory;
      if (!inv) {
        const invRes = await activeConnection.send(`player inventory "${username}"`);
        inv = invRes?.data?.Result?.[0];
      }
      if (!inv) return;

      const leftName = (inv.LeftHand?.Name || '').toLowerCase();
      const rightName = (inv.RightHand?.Name || '').toLowerCase();
      const leftId = inv.LeftHand?.Identifier;
      const rightId = inv.RightHand?.Identifier;

      // Helper function
      const holdArrowWithItem = (arrow, item) => {
        return ((leftName.includes(arrow) && rightName.includes(item)) ||
                (rightName.includes(arrow) && leftName.includes(item)));
      };

      // === SPEED ARROW (Arrow + Mythril Ingot) ===
      if (!chargedSpeedArrow && holdArrowWithItem('arrow', 'mythril ingot')) {
        if (leftName.includes('mythril ingot') && leftId) await activeConnection.send(`wacky destroy ${leftId}`);
        if (rightName.includes('mythril ingot') && rightId) await activeConnection.send(`wacky destroy ${rightId}`);
        speedArrowId = leftName.includes('arrow') ? leftId : rightId;
        chargedSpeedArrow = true;
        await activeConnection.send(`player message "${username}" "⚡ Speed Arrow charged!" 3`);
        console.log(`[SPEED ARROW] ${username} charged a speed arrow`);
      }

      // === KILL ARROW (Arrow + Orchi Ingot) ===
      if (!chargedKillArrow && holdArrowWithItem('arrow', 'orchi ingot')) {
        if (leftName.includes('orchi ingot') && leftId) await activeConnection.send(`wacky destroy ${leftId}`);
        if (rightName.includes('orchi ingot') && rightId) await activeConnection.send(`wacky destroy ${rightId}`);
        killArrowId = leftName.includes('arrow') ? leftId : rightId;
        chargedKillArrow = true;
        await activeConnection.send(`player message "${username}" "💀 Kill Arrow charged!" 3`);
        console.log(`[KILL ARROW] ${username} charged a kill arrow`);
      }

      // === DARK ARROW (Arrow + Iron Ingot) ===
      if (!chargedDarkArrow && holdArrowWithItem('arrow', 'iron ingot')) {
        if (leftName.includes('iron ingot') && leftId) await activeConnection.send(`wacky destroy ${leftId}`);
        if (rightName.includes('iron ingot') && rightId) await activeConnection.send(`wacky destroy ${rightId}`);
        darkArrowId = leftName.includes('arrow') ? leftId : rightId;
        chargedDarkArrow = true;
        await activeConnection.send(`player message "${username}" "🌑 Dark Arrow charged!" 3`);
        console.log(`[DARK ARROW] ${username} charged a dark arrow`);
      }

      // === TELEPORT ARROW (Arrow + Stone) ===
      if (!chargedTeleportArrow && holdArrowWithItem('arrow', 'stone')) {
        if (leftName.includes('stone') && leftId) await activeConnection.send(`wacky destroy ${leftId}`);
        if (rightName.includes('stone') && rightId) await activeConnection.send(`wacky destroy ${rightId}`);
        teleportArrowId = leftName.includes('arrow') ? leftId : rightId;
        chargedTeleportArrow = true;
        await activeConnection.send(`player message "${username}" "🌀 Teleport Arrow charged!" 3`);
        console.log(`[TELEPORT ARROW] ${username} charged a teleport arrow`);
      }

      // EXTREME LOGGING: Detect arrow drop (shot)
      if (changeType === "drop" && itemName.includes("arrow")) {
        // Check if user is authorized (picked up smelter gem 1)
        if (!authorizedUsers.has(username)) {
          console.log(`[ARROW BLOCKED] ${username} not authorized - needs smelter gem 1`);
          return;
        }

        // Check if holding bow in left hand
        if (!leftName.includes('bow')) {
          await activeConnection.send(`player message "${username}" "❌ You must hold a bow in your left hand to shoot special arrows!" 2`);
          console.log(`[ARROW BLOCKED] ${username} not holding bow in left hand`);
          return;
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`[ARROW SHOT DETECTED]`);
        console.log(`${'='.repeat(60)}`);
        
        const res = await activeConnection.send("player list-detailed");
        const players = res.data?.Result || [];
        const shooter = players.find(p => p.username === username);
        
        if (!shooter) {
          console.log(`[ARROW ERROR] Shooter ${username} not found in player list`);
          console.log(`${'='.repeat(60)}\n`);
          return;
        }

        // Determine arrow type
        let arrowType = 'normal';
        let arrowId = leftId || rightId;
        
        if (chargedSpeedArrow && (arrowId === speedArrowId)) {
          arrowType = 'speed';
          chargedSpeedArrow = false;
          speedArrowId = null;
        } else if (chargedKillArrow && (arrowId === killArrowId)) {
          arrowType = 'kill';
          chargedKillArrow = false;
          killArrowId = null;
        } else if (chargedDarkArrow && (arrowId === darkArrowId)) {
          arrowType = 'dark';
          chargedDarkArrow = false;
          darkArrowId = null;
        } else if (chargedTeleportArrow && (arrowId === teleportArrowId)) {
          arrowType = 'teleport';
          chargedTeleportArrow = false;
          teleportArrowId = null;
        }

        // Use RIGHT hand position and forward direction for aiming
        const startPos = shooter.RightHandPosition || shooter.HeadPosition || [0, 0, 0];
        const handForward = shooter.RightHandForward || shooter.Rotation || [0, 0, 1];
        
        // Normalize the direction vector
        const length = Math.sqrt(handForward[0]**2 + handForward[1]**2 + handForward[2]**2);
        const forwardVec = [
          handForward[0] / length,
          handForward[1] / length,
          handForward[2] / length
        ];
        
        const arrowData = {
          shooter: username,
          startPos: startPos,
          forwardVec: forwardVec,
          time: Date.now(),
          type: arrowType
        };

        activeArrows.push(arrowData);
        
        console.log(`[SHOOTER] ${username} ✅ AUTHORIZED`);
        console.log(`[ARROW TYPE] ${arrowType.toUpperCase()}`);
        console.log(`[START POS] X:${startPos[0].toFixed(2)} Y:${startPos[1].toFixed(2)} Z:${startPos[2].toFixed(2)}`);
        console.log(`[DIRECTION] X:${forwardVec[0].toFixed(3)} Y:${forwardVec[1].toFixed(3)} Z:${forwardVec[2].toFixed(3)}`);
        console.log(`[ACTIVE ARROWS] ${activeArrows.length} in flight`);
        console.log(`${'='.repeat(60)}\n`);
      }
    } catch (err) {
      console.error("\n[ARROW TRACKING ERROR]", err);
    }
  });

  // Flight + collision tracking loop
  setInterval(async () => {
    if (!activeConnection || activeArrows.length === 0) return;

    try {
      const res = await activeConnection.send("player list-detailed");
      const players = res.data?.Result || [];
      const now = Date.now();
      
      for (const arrow of [...activeArrows]) {
        const flightTime = (now - arrow.time) / 1000;

        // Calculate arrow position with realistic velocity
        const velocity = 20; // m/s
        const gravity = 9.8;
        const arrowPos = [
          arrow.startPos[0] + arrow.forwardVec[0] * flightTime * velocity,
          arrow.startPos[1] + arrow.forwardVec[1] * flightTime * velocity - 0.5 * gravity * flightTime * flightTime,
          arrow.startPos[2] + arrow.forwardVec[2] * flightTime * velocity,
        ];

        // EXTREME MAPPING: Show all player positions every second
        if (Math.floor(flightTime * 2) % 2 === 0 && flightTime > 0.5) {
          console.log(`\n[POSITION MAP] ============================================`);
          console.log(`[ARROW] Pos:[${arrowPos.map(v=>v.toFixed(1)).join(',')}] | Flight:${flightTime.toFixed(2)}s`);
          
          for (const p of players) {
            if (!p.username) continue;
            const pos = p.HeadPosition || p.position || [0,0,0];
            const looking = p.Rotation || [0,0,0];
            const leftHand = p.LeftHandPosition || [0,0,0];
            const rightHand = p.RightHandPosition || [0,0,0];
            const dist = distance3D(arrowPos, pos);
            
            const marker = p.username === arrow.shooter ? '🏹' : '🎯';
            console.log(`${marker} [${p.username}]`);
            console.log(`   Head: [${pos.map(v=>v.toFixed(1)).join(',')}]`);
            console.log(`   Look: [${looking.map(v=>v.toFixed(2)).join(',')}]`);
            console.log(`   L-Hand: [${leftHand.map(v=>v.toFixed(1)).join(',')}]`);
            console.log(`   R-Hand: [${rightHand.map(v=>v.toFixed(1)).join(',')}]`);
            console.log(`   Distance from arrow: ${dist.toFixed(2)}m`);
          }
          console.log(`========================================================\n`);
        }

        // Check collision against all players with GENEROUS hit detection
        let hitDetected = false;
        let closestPlayer = null;
        let closestDist = 999;
        
        for (const player of players) {
          if (player.username === arrow.shooter) continue;
          
          // Check multiple hit points (head, body, hands)
          const headPos = player.HeadPosition || player.position;
          const leftHand = player.LeftHandPosition;
          const rightHand = player.RightHandPosition;
          
          if (!headPos) continue;

          // Body is ~0.5m below head
          const bodyPos = [headPos[0], headPos[1] - 0.5, headPos[2]];
          
          // Calculate distances to all hit points
          const headDist = distance3D(arrowPos, headPos);
          const bodyDist = distance3D(arrowPos, bodyPos);
          let handDist = 999;
          
          if (leftHand) {
            handDist = Math.min(handDist, distance3D(arrowPos, leftHand));
          }
          if (rightHand) {
            handDist = Math.min(handDist, distance3D(arrowPos, rightHand));
          }
          
          // Use closest hit point
          const minDist = Math.min(headDist, bodyDist, handDist);
          
          if (minDist < closestDist) {
            closestDist = minDist;
            closestPlayer = player.username;
          }
          
          // GENEROUS hit detection - 5 meter sphere around player
          if (minDist < 5.0) {
            console.log(`\n${'*'.repeat(60)}`);
            console.log(`[ARROW HIT CONFIRMED]`);
            console.log(`${'*'.repeat(60)}`);
            console.log(`[SHOOTER] ${arrow.shooter}`);
            console.log(`[TARGET] ${player.username}`);
            console.log(`[ARROW TYPE] ${arrow.type.toUpperCase()}`);
            console.log(`[DISTANCE] ${minDist.toFixed(3)}m`);
            console.log(`[HIT POINT] Head:${headDist.toFixed(2)}m Body:${bodyDist.toFixed(2)}m Hands:${handDist.toFixed(2)}m`);
            console.log(`[FLIGHT TIME] ${flightTime.toFixed(2)}s`);
            console.log(`[ARROW POS] [${arrowPos.map(v=>v.toFixed(1)).join(',')}]`);
            console.log(`[TARGET HEAD] [${headPos.map(v=>v.toFixed(1)).join(',')}]`);
            console.log(`${'*'.repeat(60)}\n`);
            
            await handleArrowHit(arrow.shooter, player.username, arrow.type);
            hitDetected = true;
            break;
          }
        }

        // Remove arrow if hit detected
        if (hitDetected) {
          activeArrows = activeArrows.filter(a => a !== arrow);
          console.log(`[ARROW REMOVED] ${activeArrows.length} arrows remaining\n`);
          continue;
        }

        // Cleanup old arrows
        if (now - arrow.time > 20000) { // 10 seconds instead of 5
          if (closestPlayer) {
            console.log(`[ARROW EXPIRED] Closest approach: ${closestPlayer} at ${closestDist.toFixed(2)}m`);
          }
          console.log(`[ARROW EXPIRED] ${arrow.shooter}'s ${arrow.type} arrow timed out`);
          activeArrows = activeArrows.filter(a => a !== arrow);
        }
      }
    } catch (err) {
      console.error("\n[ARROW COLLISION ERROR]", err);
    }
  }, 100); // Check every 100ms for better accuracy

  // Handle arrow hit with different effects
  async function handleArrowHit(shooter, target, arrowType) {
    try {
      console.log(`[ARROW EFFECT] Applying ${arrowType} effect to ${target}`);
      
      switch (arrowType) {
        case 'speed':
          await activeConnection.send(`player message "${shooter}" "⚡ Your speed arrow struck ${target}!" 2`);
          await activeConnection.send(`player message "${target}" "⚡ Speed boost activated!" 2`);
          await activeConnection.send(`player modify-stat "${target}" speed 5 30`);
          break;
          
        case 'kill':
          await activeConnection.send(`player message "${shooter}" "💀 Kill arrow hit ${target}!" 2`);
          await activeConnection.send(`player message "${target}" "💀 You were killed by a kill arrow!" 2`);
          await activeConnection.send(`player kill "${target}"`);
          break;
          
        case 'dark':
          await activeConnection.send(`player message "${shooter}" "🌑 Dark arrow cursed ${target}!" 2`);
          await activeConnection.send(`player message "${target}" "🌑 You've been cursed with nightmares!" 2`);
          await activeConnection.send(`player modify-stat "${target}" nightmare 4 30`);
          break;
          
        case 'teleport':
          await activeConnection.send(`player message "${shooter}" "🌀 Teleport arrow pulled ${target} to you!" 2`);
          await activeConnection.send(`player message "${target}" "🌀 You were pulled by a teleport arrow!" 2`);
          await activeConnection.send(`player teleport "${target}" "${shooter}"`);
          break;
          
        default: // normal arrow - small speed buff
          await activeConnection.send(`player message "${shooter}" "🎯 Arrow hit ${target}!" 2`);
          await activeConnection.send(`player message "${target}" "🎯 Hit by arrow - slight speed boost!" 2`);
          await activeConnection.send(`player modify-stat "${target}" speed 2 5`);
          break;
      }
      
      console.log(`[ARROW EFFECT] ${arrowType} effect applied successfully\n`);
    } catch (err) {
      console.error("\n[ARROW HIT HANDLER ERROR]", err);
    }
  }

  console.log('[ARROW SYSTEM] Loaded with special arrow types\n');
  // ==================== ARROW SYSTEM END ====================
// ==================== DRINKING & ADDICTION SYSTEM ====================
const DRINKING_STATE = {}; // username => { drinks, lastDrink, lastTeleport, addicted, lastAddictionTick }
const ADDICTION_INTERVAL = 3 * 60 * 1000; // 3 minutes between addiction prompts
const ADDICTION_DAMAGE_INTERVAL = 5000; // 5 seconds between damage ticks
const DRINK_COOLDOWN = 3000; // 3 seconds between drinks

const RANDOM_MESSAGES = [
  "Everything is spinning...",
  "You feel dizzy...",
  "The world is blurring...",
  "You can barely stand...",
  "Your vision is fading...",
  "You feel sick...",
  "Everything hurts...",
  "You're losing control...",
  "The room is spinning...",
  "You can't think straight..."
];

function calculateDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

// Main drinking/addiction check loop
setInterval(async () => {
  if (!activeConnection) return;
  const connection = activeConnection;

  try {
    const res = await connection.send('player list-detailed');
    const players = res.data?.Result || [];
    const now = Date.now();

    for (const player of players) {
      const username = player.username;
      if (!username) continue;

      // Initialize state if needed
      if (!DRINKING_STATE[username]) {
        DRINKING_STATE[username] = {
          drinks: 0,
          lastDrink: 0,
          lastTeleport: 0,
          addicted: false,
          lastAddictionTick: 0,
          lastAddictionPrompt: 0
        };
      }

      const state = DRINKING_STATE[username];
      const invRes = await connection.send(`player inventory "${username}"`);
      const inv = invRes.data?.Result?.[0];
      if (!inv) continue;

      const head = player.HeadPosition;
      const leftHand = player.LeftHandPosition;
      const rightHand = player.RightHandPosition;
      if (!head || !leftHand || !rightHand) continue;

      const leftName = inv.LeftHand?.Name?.toLowerCase() || '';
      const rightName = inv.RightHand?.Name?.toLowerCase() || '';

      // === DRINKING POTION MEDIUM ===
      const holdingPotion = leftName.includes('potion medium') || rightName.includes('potion medium');
      const leftDist = calculateDistance(leftHand, head);
      const rightDist = calculateDistance(rightHand, head);
      const leftNearHead = leftDist <= 0.5;
      const rightNearHead = rightDist <= 0.5;
      const drinkingPotion = holdingPotion && (leftNearHead || rightNearHead);

      if (drinkingPotion && now - state.lastDrink > DRINK_COOLDOWN) {
        state.drinks++;
        state.lastDrink = now;

        // Destroy the potion
        if (leftName.includes('potion medium') && inv.LeftHand?.Identifier) {
          await connection.send(`wacky destroy ${inv.LeftHand.Identifier}`);
        }
        if (rightName.includes('potion medium') && inv.RightHand?.Identifier) {
          await connection.send(`wacky destroy ${inv.RightHand.Identifier}`);
        }

        console.log(`[DRINKING] ${username} drank potion #${state.drinks}`);

        // Apply effects based on drink count
        if (state.drinks === 10) {
          // Death at 10 drinks
          await connection.send(`player kill "${username}"`);
          await connection.send(`player modify-stat "${username}" speed -8 1200`); // 20 min speed debuff
          await connection.send(`player message "${username}" "💀 You drank too much and died! -8 speed for 20 minutes." 10`);
          state.drinks = 0; // Reset after death
          continue;
        }

        // Frost effect (increases with drinks)
        await connection.send(`player modify-stat "${username}" frost ${state.drinks} 2 max`);
        await connection.send(`player modify-stat "${username}" frost ${state.drinks} 2`);
        // Speed debuff starts at 2 drinks
        if (state.drinks >= 2) {
          const speedDebuff = -1 * Math.floor(state.drinks / 2);
          await connection.send(`player modify-stat "${username}" speed ${speedDebuff} 60`);
        }

        // Damage debuff starts at 3 drinks
        if (state.drinks >= 3) {
          const damageDebuff = -1 * Math.floor(state.drinks / 3);
          await connection.send(`player modify-stat "${username}" damage ${damageDebuff} 60`);
        }

        // Random message
        const randomMsg = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];
        await connection.send(`player message "${username}" "${randomMsg}" 4`);

        await connection.send(`player message "${username}" "Drinks: ${state.drinks}/10 | Frost: ${state.drinks}" 5`);
      }

      // === RANDOM TELEPORTS (starts at 2 drinks) ===
      if (state.drinks >= 2) {
        const tpInterval = Math.max(1000, 10000 - (state.drinks * 800)); // Gets faster with more drinks
        if (now - state.lastTeleport > tpInterval) {
          state.lastTeleport = now;

          // Random small teleport
          const pos = player.Position;
          const randomX = pos[0] + (Math.random() - 0.5) * (state.drinks * 0.5);
          const randomY = pos[1];
          const randomZ = pos[2] + (Math.random() - 0.5) * (state.drinks * 0.5);

          await connection.send(`player set-home "${player.id}" ${randomX},${randomY},${randomZ}`);
          await connection.send(`player teleport "${player.id}" home`);
          await connection.send(`player set-home "${player.id}" 0,0,0`);

          const randomMsg = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];
          await connection.send(`player message "${username}" "${randomMsg}" 2`);
        }
      }

      // === ADDICTION SYSTEM (Handle Short Taper) ===
      const holdingTaper = leftName.includes('handle short taper') || rightName.includes('handle short taper');
      const drinkingTaper = holdingTaper && (leftNearHead || rightNearHead);

      // First time using taper - become addicted
      if (drinkingTaper && !state.addicted && now - state.lastDrink > DRINK_COOLDOWN) {
        state.addicted = true;
        state.lastAddictionPrompt = now;
        state.lastAddictionTick = now;
        state.lastDrink = now; // Use drink cooldown

        await connection.send(`player message "${username}" "⚠️ You are now addicted! Use vape every few minutes or suffer." 8`);
        console.log(`[ADDICTION] ${username} became addicted`);
      }

      // Satisfy addiction if already addicted
      if (drinkingTaper && state.addicted && now - state.lastDrink > DRINK_COOLDOWN) {
        state.lastAddictionPrompt = now;
        state.lastAddictionTick = now;
        state.lastDrink = now;

        await connection.send(`player message "${username}" "✅ Addiction satisfied for now..." 4`);
        console.log(`[ADDICTION] ${username} satisfied addiction`);
      }

      // Addiction withdrawal damage
      if (state.addicted) {
        const timeSincePrompt = now - state.lastAddictionPrompt;

        // Warn at 2.5 minutes
        if (timeSincePrompt > ADDICTION_INTERVAL - 30000 && timeSincePrompt < ADDICTION_INTERVAL - 25000) {
          await connection.send(`player message "${username}" "⚠️ You need to use vape soon or you'll suffer!" 6`);
        }

        // Start damage after addiction interval
        if (timeSincePrompt > ADDICTION_INTERVAL) {
          if (now - state.lastAddictionTick > ADDICTION_DAMAGE_INTERVAL) {
            state.lastAddictionTick = now;
            await connection.send(`player damage "${username}" 0.1`);
            await connection.send(`player message "${username}" "💉 Withdrawal is hurting you! Use vape!" 3`);
            console.log(`[ADDICTION] ${username} taking withdrawal damage`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[DRINKING/ADDICTION ERROR]', e.message);
  }
}, 1000); // Check every second for responsiveness

console.log('[DRINKING & ADDICTION SYSTEM] Loaded successfully');
// ==================== STARLIGHT ABILITY SYSTEM ====================
const starlightCooldowns = {}; // username => timestamp (for individual target cooldown)
const starlightActive = {}; // username => { active: bool, startTime: timestamp, lastTick: timestamp }

function calculateDistanceStarlight(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

setInterval(async () => {
  if (!activeConnection) return;
  const connection = activeConnection;
  
  try {
    const res = await connection.send('player list-detailed');
    const players = res.data?.Result || [];
    const now = Date.now();
    
    for (const caster of players) {
      const casterName = caster.username;
      if (!casterName) continue;
      
      // Check if user is authorized (picked up smelter gem 1)
      if (!authorizedUsers.has(casterName)) {
        console.log(`[STARLIGHT] ${casterName} not authorized - skipping`);
        continue;
      }
      
      // Get inventory
      const invRes = await connection.send(`player inventory "${casterName}"`);
      const inv = invRes.data?.Result?.[0];
      if (!inv) {
        console.log(`[STARLIGHT] ${casterName} no inventory - skipping`);
        continue;
      }
      
      const leftName = inv.LeftHand?.Name?.toLowerCase() || '';
      const rightName = inv.RightHand?.Name?.toLowerCase() || '';
      
      console.log(`[STARLIGHT] ${casterName} holding: L="${leftName}" R="${rightName}"`);
      
      // Check if holding "handle large cool"
      const holdingStarlight = leftName.includes('handle large cool') || rightName.includes('handle large cool');
      
      // Check if starlight is locked on (can't turn off for 5 seconds)
      if (starlightActive[casterName]?.active) {
        const timeSinceStart = now - starlightActive[casterName].startTime;
        if (timeSinceStart < 5000) {
          console.log(`[STARLIGHT] ${casterName} locked in starlight mode for ${((5000 - timeSinceStart) / 1000).toFixed(1)}s more`);
          // Force continue even if not holding item - SPAM MODE ACTIVE
        } else {
          // 5 seconds passed, can turn off now
          if (!holdingStarlight) {
            console.log(`[STARLIGHT] ${casterName} starlight deactivated after 5s`);
            starlightActive[casterName] = { active: false, startTime: 0, lastTick: 0 };
            continue;
          }
        }
      } else {
        if (!holdingStarlight) continue;
      }
      
      console.log(`[STARLIGHT] ${casterName} IS holding handle large cool!`);
      
      const casterHead = caster.HeadPosition;
      const casterLH = caster.LeftHandPosition;
      const casterRH = caster.RightHandPosition;
      if (!casterHead || !casterLH || !casterRH) {
        console.log(`[STARLIGHT] ${casterName} missing position data`);
        continue;
      }
      
      // Check if hand is ABOVE head (y-coordinate higher)
      const leftAboveHead = casterLH[1] > casterHead[1] + 0.2;
      const rightAboveHead = casterRH[1] > casterHead[1] + 0.2;
      
      console.log(`[STARLIGHT] ${casterName} hand heights - Head Y:${casterHead[1].toFixed(2)} | L Y:${casterLH[1].toFixed(2)} (above=${leftAboveHead}) | R Y:${casterRH[1].toFixed(2)} (above=${rightAboveHead})`);
      
      if (!leftAboveHead && !rightAboveHead) {
        console.log(`[STARLIGHT] ${casterName} hands not above head`);
        continue;
      }
      
      console.log(`[STARLIGHT] ${casterName} HAND IS ABOVE HEAD! Checking for targets...`);
      
      // Initialize active state if first time
      if (!starlightActive[casterName]) {
        starlightActive[casterName] = { active: false, startTime: 0, lastTick: 0 };
      }
      
      // Tick rate limiter - spam every 1 second
      if (starlightActive[casterName].active && now - starlightActive[casterName].lastTick < 1000) {
        console.log(`[STARLIGHT] ${casterName} waiting for next tick...`);
        continue;
      }
      
      // Now scan for targets near the caster's hands (including self)
      let foundTarget = false;
      for (const target of players) {
        const targetName = target.username;
        if (!targetName) continue;
        
        const targetHead = target.HeadPosition;
        if (!targetHead) continue;
        
        const lhDist = calculateDistanceStarlight(casterLH, targetHead);
        const rhDist = calculateDistanceStarlight(casterRH, targetHead);
        const lhNear = lhDist <= 0.5;
        const rhNear = rhDist <= 0.5;
        
        console.log(`[STARLIGHT] ${casterName} -> ${targetName}: L dist=${lhDist.toFixed(2)}m (near=${lhNear}) | R dist=${rhDist.toFixed(2)}m (near=${rhNear})`);
        
        if (!lhNear && !rhNear) continue;
        
        // === STARLIGHT ABILITY ACTIVATED ===
        console.log(`[STARLIGHT] ⭐⭐⭐ ${casterName} ACTIVATED on ${targetName} ⭐⭐⭐`);
        
        await connection.send(`player progression clearall "${targetName}"`);
        await new Promise(r => setTimeout(r, 100));
        await connection.send(`player progression allxp "${targetName}" 9999`);
        await new Promise(r => setTimeout(r, 100));
        await connection.send(`player modify-stat "${casterName}" Luminosity 50 10`);
        
        if (targetName === casterName) {
          await connection.send(`player message "${casterName}" "⭐ Starlight pulsing!" 2`);
        } else {
          await connection.send(`player message "${casterName}" "⭐ Starlight pulsing on ${targetName}!" 2`);
          await connection.send(`player message "${targetName}" "⭐ Starlight blessing you!" 2`);
        }
        
        // Mark as active and update tick time
        if (!starlightActive[casterName].active) {
          starlightActive[casterName] = { active: true, startTime: now, lastTick: now };
          console.log(`[STARLIGHT] ${casterName} SPAM MODE ACTIVATED - locked for 5s`);
        } else {
          starlightActive[casterName].lastTick = now;
          console.log(`[STARLIGHT] ${casterName} spam tick executed`);
        }
        
        foundTarget = true;
        break; // Only affect one target per tick
      }
      
      if (!foundTarget) {
        console.log(`[STARLIGHT] ${casterName} no valid targets in range`);
      }
    }
  } catch (e) {
    console.error('[STARLIGHT ERROR]', e.message, e.stack);
  }
}, 500); // Check every half second

console.log('[STARLIGHT ABILITY] Loaded successfully');
// ==================== COMBAT SYSTEM ====================
const combatHitCooldowns = {}; // "attacker-target" => timestamp
const combatAgreements = {}; // "player1-player2" => { expires: timestamp, initiated: bool }
const COMBAT_DURATION = 10 * 60 * 1000; // 10 minutes

function calculateDistanceCombat(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

function getCombatKey(player1, player2) {
  // Always sort alphabetically to ensure consistent key
  return [player1, player2].sort().join('-');
}

function canFight(player1, player2) {
  const key = getCombatKey(player1, player2);
  const agreement = combatAgreements[key];
  
  if (!agreement) return false;
  
  const now = Date.now();
  if (now > agreement.expires) {
    delete combatAgreements[key];
    return false;
  }
  
  return true;
}

function getPlayerLimbs(player) {
  // Return all limb positions for hitbox detection
  const limbs = [];
  
  if (player.HeadPosition) {
    limbs.push({ name: 'head', pos: player.HeadPosition, radius: 0.15 });
  }
  
  if (player.LeftHandPosition) {
    limbs.push({ name: 'left_hand', pos: player.LeftHandPosition, radius: 0.1 });
  }
  
  if (player.RightHandPosition) {
    limbs.push({ name: 'right_hand', pos: player.RightHandPosition, radius: 0.1 });
  }
  
  // Estimate body center (between head and ground)
  if (player.HeadPosition) {
    const bodyPos = [
      player.HeadPosition[0],
      player.HeadPosition[1] - 0.5, // Body is ~0.5m below head
      player.HeadPosition[2]
    ];
    limbs.push({ name: 'body', pos: bodyPos, radius: 0.25 });
  }
  
  return limbs;
}

function calculateDirectionalKnockback(attackerHand, handForward) {
  // Use the hand's forward direction for knockback
  // handForward is the direction the hand is pointing
  
  if (!handForward) return [0, 0, 0];
  
  // Normalize the forward vector
  const length = Math.sqrt(
    handForward[0] * handForward[0] +
    handForward[1] * handForward[1] +
    handForward[2] * handForward[2]
  );
  
  if (length === 0) return [0, 0, 0];
  
  const knockbackStrength = 0.5; // Knockback distance
  return [
    (handForward[0] / length) * knockbackStrength,
    (handForward[1] / length) * knockbackStrength,
    (handForward[2] / length) * knockbackStrength
  ];
}

setInterval(async () => {
  if (!activeConnection) return;
  const connection = activeConnection;
  
  try {
    const res = await connection.send('player list-detailed');
    const players = res.data?.Result || [];
    const now = Date.now();
    
    // === PHASE 1: Check for combat initiation (mutual face touching) ===
    for (const player1 of players) {
      const p1Name = player1.username;
      if (!p1Name || !authorizedUsers.has(p1Name)) continue;
      
      const p1LH = player1.LeftHandPosition;
      const p1RH = player1.RightHandPosition;
      if (!p1LH || !p1RH) continue;
      
      for (const player2 of players) {
        const p2Name = player2.username;
        if (!p2Name || p2Name === p1Name || !authorizedUsers.has(p2Name)) continue;
        
        const p2Head = player2.HeadPosition;
        const p2LH = player2.LeftHandPosition;
        const p2RH = player2.RightHandPosition;
        if (!p2Head || !p2LH || !p2RH) continue;
        
        // Check if player1's hand is touching player2's face
        const p1TouchingP2Face = (
          calculateDistanceCombat(p1LH, p2Head) < 0.3 ||
          calculateDistanceCombat(p1RH, p2Head) < 0.3
        );
        
        // Check if player2's hand is touching player1's face
        const p1Head = player1.HeadPosition;
        if (!p1Head) continue;
        
        const p2TouchingP1Face = (
          calculateDistanceCombat(p2LH, p1Head) < 0.3 ||
          calculateDistanceCombat(p2RH, p1Head) < 0.3
        );
        
        // Both players touching each other's faces = mutual consent!
        if (p1TouchingP2Face && p2TouchingP1Face) {
          const key = getCombatKey(p1Name, p2Name);
          
          if (!combatAgreements[key] || now > combatAgreements[key].expires) {
            // Start new combat agreement
            combatAgreements[key] = {
              expires: now + COMBAT_DURATION,
              initiated: true
            };
            
            await connection.send(`player message "${p1Name}" "⚔️ Combat started with ${p2Name} for 10 minutes!" 5`);
            await connection.send(`player message "${p2Name}" "⚔️ Combat started with ${p1Name} for 10 minutes!" 5`);
            
            console.log(`[COMBAT] ${p1Name} and ${p2Name} started combat session`);
          }
        }
      }
    }
    
    // === PHASE 2: Process combat hits (only between consenting players) ===
    for (const attacker of players) {
      const attackerName = attacker.username;
      if (!attackerName || !authorizedUsers.has(attackerName)) continue;
      
      const attackerLH = attacker.LeftHandPosition;
      const attackerRH = attacker.RightHandPosition;
      const attackerLHForward = attacker.LeftHandForward;
      const attackerRHForward = attacker.RightHandForward;
      
      if (!attackerLH || !attackerRH) continue;
      
      // Scan for valid combat targets
      for (const target of players) {
        const targetName = target.username;
        if (!targetName || targetName === attackerName) continue;
        
        // Check if these two players can fight
        if (!canFight(attackerName, targetName)) continue;
        
        // Get all limb hitboxes for target
        const targetLimbs = getPlayerLimbs(target);
        
        // Check BOTH attacker hands against all target limbs
        const hands = [
          { pos: attackerLH, forward: attackerLHForward, name: 'left' },
          { pos: attackerRH, forward: attackerRHForward, name: 'right' }
        ];
        
        for (const hand of hands) {
          for (const limb of targetLimbs) {
            const distance = calculateDistanceCombat(hand.pos, limb.pos);
            
            // Hit detection with limb-specific radius
            if (distance <= limb.radius + 0.1) { // 0.1m punch reach
              const hitKey = `${attackerName}-${targetName}`;
              
              // Fast cooldown per target (150ms between hits)
              if (combatHitCooldowns[hitKey] && now - combatHitCooldowns[hitKey] < 150) {
                continue;
              }
              
              console.log(`[COMBAT] ${attackerName} (${hand.name} hand) hit ${targetName}'s ${limb.name}!`);
              
              // Calculate knockback based on hand direction
              const knockback = calculateDirectionalKnockback(hand.pos, hand.forward);
              const targetPos = target.Position || target.HeadPosition;
              
              if (targetPos && knockback) {
                const newX = targetPos[0] + knockback[0];
                const newY = targetPos[1] + knockback[1];
                const newZ = targetPos[2] + knockback[2];
                
                console.log(`[COMBAT] Knockback: [${knockback[0].toFixed(2)}, ${knockback[1].toFixed(2)}, ${knockback[2].toFixed(2)}]`);
                
                // Apply knockback by teleporting
                await connection.send(`player set-home "${target.id}" ${newX},${newY},${newZ}`);
                await connection.send(`player teleport "${target.id}" home`);
                await connection.send(`player set-home "${target.id}" 0,0,0`);
              }
              
              // Apply damage
              await connection.send(`player damage "${targetName}" 0.001`);
              
              // Visual feedback
              await connection.send(`player message "${targetName}" "💥" 1`);
              
              combatHitCooldowns[hitKey] = now;
              
              // Only register one hit per check to avoid spam
              break;
            }
          }
        }
      }
    }
    
    // Clean up expired agreements
    for (const key in combatAgreements) {
      if (now > combatAgreements[key].expires) {
        const [p1, p2] = key.split('-');
        console.log(`[COMBAT] Combat session expired between ${p1} and ${p2}`);
        delete combatAgreements[key];
      }
    }
    
  } catch (e) {
    console.error('[COMBAT ERROR]', e.message);
  }
}, 20); // Check every 20ms for responsive combat

console.log('[COMBAT SYSTEM] Loaded - mutual consent combat enabled!');
//=============== TAVERN CONTROL SYSTEM ====================
const TAVERN_BOUNDS = {
  corner1: [-820.584, 134.652, 3.898],
  corner2: [-790.43, 134.652, 4.882],
  corner3: [-793.383, 134.733, -14.6989994],
  corner4: [-819.877136, 134.651733, -14.5980005]
};

const TAVERN_BUTTONS = {
  close: [-807.279358, 136.640411, -9.039759],
  ban: [-807.264343, 136.6538, -7.29912663],
  list: [-807.2432, 136.662, -5.753436]
};

const tavernState = {
  closed: false,
  lastCloseTime: 0,
  awaitingConfirm: {}, // username => timestamp
  awaitingBan: {}, // username => timestamp
  bannedPlayers: [] // Load from JSON
};

const buttonCooldowns = {};
const fs = require('fs');
const path = require('path');
const BAN_FILE = path.join(__dirname, 'tavern_bans.json');

// Load banned players from file
function loadBannedPlayers() {
  try {
    if (fs.existsSync(BAN_FILE)) {
      const data = fs.readFileSync(BAN_FILE, 'utf8');
      tavernState.bannedPlayers = JSON.parse(data);
      console.log(`[TAVERN] Loaded ${tavernState.bannedPlayers.length} banned players`);
    }
  } catch (e) {
    console.error('[TAVERN] Error loading bans:', e.message);
    tavernState.bannedPlayers = [];
  }
}

// Save banned players to file
function saveBannedPlayers() {
  try {
    fs.writeFileSync(BAN_FILE, JSON.stringify(tavernState.bannedPlayers, null, 2));
    console.log(`[TAVERN] Saved ${tavernState.bannedPlayers.length} banned players`);
  } catch (e) {
    console.error('[TAVERN] Error saving bans:', e.message);
  }
}

// Check if position is inside tavern bounds
function isInTavern(pos) {
  if (!pos) return false;
  
  // Get min/max X and Z from corners
  const xCoords = [TAVERN_BOUNDS.corner1[0], TAVERN_BOUNDS.corner2[0], TAVERN_BOUNDS.corner3[0], TAVERN_BOUNDS.corner4[0]];
  const zCoords = [TAVERN_BOUNDS.corner1[2], TAVERN_BOUNDS.corner2[2], TAVERN_BOUNDS.corner3[2], TAVERN_BOUNDS.corner4[2]];
  
  const minX = Math.min(...xCoords);
  const maxX = Math.max(...xCoords);
  const minZ = Math.min(...zCoords);
  const maxZ = Math.max(...zCoords);
  const minY = 134; // Ground level
  const maxY = 140; // Ceiling
  
  return pos[0] >= minX && pos[0] <= maxX &&
         pos[1] >= minY && pos[1] <= maxY &&
         pos[2] >= minZ && pos[2] <= maxZ;
}

function calculateDistanceTavern(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

// Load bans on startup
loadBannedPlayers();

setInterval(async () => {
  if (!activeConnection) return;
  const connection = activeConnection;
  
  try {
    const res = await connection.send('player list-detailed');
    const players = res.data?.Result || [];
    const now = Date.now();
    
    for (const player of players) {
      const username = player.username;
      if (!username) continue;
      
      // Check if user is authorized (picked up smelter gem 1)
      if (!authorizedUsers.has(username)) continue;
      
      const playerPos = player.Position || player.HeadPosition;
      const leftHand = player.LeftHandPosition;
      const rightHand = player.RightHandPosition;
      
      if (!playerPos || !leftHand || !rightHand) continue;
      
      // === BUTTON 1: CLOSE/OPEN TAVERN ===
      const distClose = calculateDistanceTavern(leftHand, TAVERN_BUTTONS.close);
      const distCloseR = calculateDistanceTavern(rightHand, TAVERN_BUTTONS.close);
      
      if (distClose < 0.3 || distCloseR < 0.3) {
        const cooldownKey = `${username}-close`;
        if (buttonCooldowns[cooldownKey] && now - buttonCooldowns[cooldownKey] < 1000) continue;
        
        // Check if awaiting confirmation
        if (tavernState.awaitingConfirm[username]) {
          // Check if hands are together
          const handsDist = calculateDistanceTavern(leftHand, rightHand);
          
          if (handsDist < 0.2) {
            // CONFIRMED!
            const action = tavernState.closed ? 'open' : 'close';
            
            if (action === 'close') {
              // Close tavern - kick everyone out
              tavernState.closed = true;
              tavernState.lastCloseTime = now;
              
              let kickCount = 0;
              for (const target of players) {
                if (!target.username || target.username === username) continue;
                
                const targetPos = target.Position || target.HeadPosition;
                if (isInTavern(targetPos)) {
                  // Teleport outside (spawn point)
                  await connection.send(`player teleport "${target.id}"`);
                  await connection.send(`player message "${target.username}" "🚪 Tavern is now closed!" 5`);
                  kickCount++;
                }
              }
              
              await connection.send(`player message "${username}" "🔒 Tavern closed! Kicked ${kickCount} players." 5`);
              console.log(`[TAVERN] ${username} closed tavern, kicked ${kickCount} players`);
              
            } else {
              // Check 2 minute cooldown
              const timeSinceClose = now - tavernState.lastCloseTime;
              if (timeSinceClose < 120000) {
                const remaining = ((120000 - timeSinceClose) / 1000).toFixed(0);
                await connection.send(`player message "${username}" "⏳ Must wait ${remaining}s to reopen!" 3`);
              } else {
                tavernState.closed = false;
                await connection.send(`player message "${username}" "🔓 Tavern opened!" 5`);
                console.log(`[TAVERN] ${username} opened tavern`);
              }
            }
            
            delete tavernState.awaitingConfirm[username];
            buttonCooldowns[cooldownKey] = now;
          }
        } else {
          // Start confirmation
          tavernState.awaitingConfirm[username] = now;
          const action = tavernState.closed ? 'OPEN' : 'CLOSE';
          await connection.send(`player message "${username}" "🤝 Put hands together to confirm ${action}" 3`);
          
          // Clear confirmation after 5 seconds
          setTimeout(() => {
            if (tavernState.awaitingConfirm[username]) {
              delete tavernState.awaitingConfirm[username];
            }
          }, 5000);
        }
      }
      
      // === BUTTON 2: BAN PLAYER ===
      const distBan = calculateDistanceTavern(leftHand, TAVERN_BUTTONS.ban);
      const distBanR = calculateDistanceTavern(rightHand, TAVERN_BUTTONS.ban);
      
      if (distBan < 0.3 || distBanR < 0.3) {
        const cooldownKey = `${username}-ban`;
        if (buttonCooldowns[cooldownKey] && now - buttonCooldowns[cooldownKey] < 1000) continue;
        
        if (!tavernState.awaitingBan[username]) {
          // Activate ban mode
          tavernState.awaitingBan[username] = now;
          await connection.send(`player message "${username}" "🚫 BAN MODE: Touch someone's face to ban/unban them!" 5`);
          console.log(`[TAVERN] ${username} activated ban mode`);
          
          // Clear after 10 seconds
          setTimeout(() => {
            if (tavernState.awaitingBan[username]) {
              delete tavernState.awaitingBan[username];
              connection.send(`player message "${username}" "🚫 Ban mode expired" 2`);
            }
          }, 10000);
          
          buttonCooldowns[cooldownKey] = now;
        }
      }
      
      // Check if in ban mode and touching someone's face
      if (tavernState.awaitingBan[username]) {
        for (const target of players) {
          if (!target.username || target.username === username) continue;
          
          const targetHead = target.HeadPosition;
          if (!targetHead) continue;
          
          const distToHeadL = calculateDistanceTavern(leftHand, targetHead);
          const distToHeadR = calculateDistanceTavern(rightHand, targetHead);
          
          if (distToHeadL < 0.3 || distToHeadR < 0.3) {
            // Toggle ban
            const banIndex = tavernState.bannedPlayers.indexOf(target.username);
            
            if (banIndex === -1) {
              // Ban player
              tavernState.bannedPlayers.push(target.username);
              saveBannedPlayers();
              await connection.send(`player message "${username}" "🚫 Banned ${target.username} from tavern!" 5`);
              await connection.send(`player message "${target.username}" "🚫 You've been banned from the tavern!" 5`);
              
              // Kick them out if inside
              const targetPos = target.Position || target.HeadPosition;
              if (isInTavern(targetPos)) {
                await connection.send(`player teleport "${target.id}"`);
              }
              
              console.log(`[TAVERN] ${username} banned ${target.username}`);
            } else {
              // Unban player
              tavernState.bannedPlayers.splice(banIndex, 1);
              saveBannedPlayers();
              await connection.send(`player message "${username}" "✅ Unbanned ${target.username}!" 5`);
              await connection.send(`player message "${target.username}" "✅ You've been unbanned from the tavern!" 5`);
              console.log(`[TAVERN] ${username} unbanned ${target.username}`);
            }
            
            delete tavernState.awaitingBan[username];
            break;
          }
        }
      }
      
      // === BUTTON 3: LIST PLAYERS ===
      const distList = calculateDistanceTavern(leftHand, TAVERN_BUTTONS.list);
      const distListR = calculateDistanceTavern(rightHand, TAVERN_BUTTONS.list);
      
      if (distList < 0.3 || distListR < 0.3) {
        const cooldownKey = `${username}-list`;
        if (buttonCooldowns[cooldownKey] && now - buttonCooldowns[cooldownKey] < 2000) continue;
        
        // Count players in tavern
        const playersInTavern = [];
        for (const p of players) {
          if (!p.username) continue;
          const pos = p.Position || p.HeadPosition;
          if (isInTavern(pos)) {
            playersInTavern.push(p.username);
          }
        }
        
        if (playersInTavern.length === 0) {
          await connection.send(`player message "${username}" "📋 Tavern is empty" 4`);
        } else {
          const list = playersInTavern.join(", ");
          await connection.send(`player message "${username}" "📋 In tavern: ${list}" 6`);
        }
        
        console.log(`[TAVERN] ${username} checked tavern list: ${playersInTavern.length} players`);
        buttonCooldowns[cooldownKey] = now;
      }
    }
    
    // === ENFORCE TAVERN CLOSURE & BANS ===
    for (const player of players) {
      if (!player.username) continue;
      
      const playerPos = player.Position || player.HeadPosition;
      const leftHand = player.LeftHandPosition;
      const rightHand = player.RightHandPosition;
      
      // Check ALL positions (body, head, hands)
      const bodyInside = playerPos && isInTavern(playerPos);
      const leftHandInside = leftHand && isInTavern(leftHand);
      const rightHandInside = rightHand && isInTavern(rightHand);
      const headInside = player.HeadPosition && isInTavern(player.HeadPosition);
      
      const anyPartInside = bodyInside || leftHandInside || rightHandInside || headInside;
      
      if (!anyPartInside) continue; // Skip if not inside at all
      
      // PRIORITY 1: Check if banned (bans override everything, even authorization)
      if (tavernState.bannedPlayers.includes(player.username)) {
        console.log(`[TAVERN DEBUG] Attempting to TP banned player ${player.username}, ID: ${player.id}`);
        const tpResult = await connection.send(`player teleport "${player.id}"`);
        console.log(`[TAVERN DEBUG] TP Result:`, tpResult);
        await connection.send(`player message "${player.username}" "🚫 You're banned from the tavern!" 3`);
        console.log(`[TAVERN] Ejected banned player: ${player.username}`);
        continue;
      }
      
      // PRIORITY 2: Check if tavern is closed (authorized users can stay)
      if (tavernState.closed && !authorizedUsers.has(player.username)) {
        console.log(`[TAVERN DEBUG] Closed - attempting to TP ${player.username}, ID: ${player.id}, authorized: ${authorizedUsers.has(player.username)}`);
        const tpResult = await connection.send(`player teleport "${player.id}"`);
        console.log(`[TAVERN DEBUG] TP Result:`, tpResult);
        await connection.send(`player message "${player.username}" "🔒 Tavern is closed!" 3`);
        console.log(`[TAVERN] Ejected player from closed tavern: ${player.username}`);
      }
    }
    
  } catch (e) {
    console.error('[TAVERN ERROR]', e.message);
  }
}, 500); // Check twice per second

console.log('[TAVERN CONTROL SYSTEM] Loaded successfully');
// ==================== STONE TELEPORT SYSTEM ====================
const STONE_TP_POS = [-615.052551, 186.53363, 356.523682];
const stoneTpCooldowns = {}; // username => timestamp

function calculateDistanceStoneTp(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

setInterval(async () => {
  if (!activeConnection) return;
  const connection = activeConnection;
  
  try {
    const res = await connection.send('player list-detailed');
    const players = res.data?.Result || [];
    const now = Date.now();
    
    for (const player of players) {
      const username = player.username;
      if (!username) continue;
      
      // Stone teleport is available to everyone (not blacklisted)
      
      const leftHand = player.LeftHandPosition;
      const rightHand = player.RightHandPosition;
      
      if (!leftHand || !rightHand) continue;
      
      // Get inventory
      const invRes = await connection.send(`player inventory "${username}"`);
      const inv = invRes.data?.Result?.[0];
      if (!inv) continue;
      
      const leftName = inv.LeftHand?.Name?.toLowerCase() || '';
      const rightName = inv.RightHand?.Name?.toLowerCase() || '';
      const leftId = inv.LeftHand?.Identifier;
      const rightId = inv.RightHand?.Identifier;
      
      // Check if holding stone
      const holdingStone = leftName.includes('stone') || rightName.includes('stone');
      if (!holdingStone) continue;
      
      // Check if either hand is near the teleport position
      const leftDist = calculateDistanceStoneTp(leftHand, STONE_TP_POS);
      const rightDist = calculateDistanceStoneTp(rightHand, STONE_TP_POS);
      
      const threshold = 0.5; // 0.5 meter radius
      const isNear = leftDist < threshold || rightDist < threshold;
      
      if (!isNear) continue;
      
      // Check cooldown (2 seconds)
      const cooldownKey = `${username}-stonetp`;
      if (stoneTpCooldowns[cooldownKey] && now - stoneTpCooldowns[cooldownKey] < 2000) {
        continue;
      }
      
      console.log(`[STONE TP] ${username} activated stone teleport!`);
      
      // Destroy the stone
      if (leftName.includes('stone') && leftId) {
        await connection.send(`wacky destroy ${leftId}`);
      }
      if (rightName.includes('stone') && rightId) {
        await connection.send(`wacky destroy ${rightId}`);
      }
      
      // Teleport to spawn
      await connection.send(`player teleport "${username}"`);
      
      // Apply speed boost
      await connection.send(`player modify-stat "${username}" speed 3 1000`);
      
      // Message
      await connection.send(`player message "${username}" "🌀 Stone teleport activated!" 3`);
      
      stoneTpCooldowns[cooldownKey] = now;
    }
  } catch (e) {
    console.error('[STONE TP ERROR]', e.message);
  }
}, 200); // Check 5 times per second

console.log('[STONE TELEPORT SYSTEM] Loaded successfully');
// ==================== END STONE TELEPORT SYSTEM ====================
// ==================== AUTO-FORGE SYSTEM ====================
const AUTO_FORGE_POS = [-729.0717, 134.315247, 14.2872066];
const AUTO_FORGE_COST = 50;
const autoForgeState = {}; // username => { awaitingConfirm: bool, timestamp: number }
const autoForgeCooldowns = {}; // username => timestamp

function calculateDistanceAutoForge(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

setInterval(async () => {
  if (!activeConnection) return;
  const connection = activeConnection;
  
  try {
    const res = await connection.send('player list-detailed');
    const players = res.data?.Result || [];
    const now = Date.now();
    
    for (const player of players) {
      const username = player.username;
      if (!username) continue;
      
      const leftHand = player.LeftHandPosition;
      const rightHand = player.RightHandPosition;
      
      if (!leftHand || !rightHand) continue;
      
      // Check if either hand is near the auto-forge position
      const leftDist = calculateDistanceAutoForge(leftHand, AUTO_FORGE_POS);
      const rightDist = calculateDistanceAutoForge(rightHand, AUTO_FORGE_POS);
      
      const threshold = 0.3; // 0.3 meter radius
      const isNear = leftDist < threshold || rightDist < threshold;
      
      // Initialize state if needed
      if (!autoForgeState[username]) {
        autoForgeState[username] = { awaitingConfirm: false, timestamp: 0 };
      }
      
      if (isNear) {
        // Check cooldown (1 second to prevent spam)
        if (autoForgeCooldowns[username] && now - autoForgeCooldowns[username] < 1000) {
          continue;
        }
        
        if (!autoForgeState[username].awaitingConfirm) {
          // First touch - request confirmation
          autoForgeState[username].awaitingConfirm = true;
          autoForgeState[username].timestamp = now;
          
          await connection.send(`player message "${username}" "🤝 Put your hands together to confirm auto-forge (Cost: ${AUTO_FORGE_COST} coins)" 5`);
          console.log(`[AUTO-FORGE] ${username} requested auto-forge`);
          
          // Clear confirmation after 10 seconds
          setTimeout(() => {
            if (autoForgeState[username]?.awaitingConfirm) {
              autoForgeState[username].awaitingConfirm = false;
              connection.send(`player message "${username}" "⏱️ Auto-forge confirmation expired" 2`);
            }
          }, 10000);
          
          autoForgeCooldowns[username] = now;
        }
      }
      
      // Check if awaiting confirmation and hands are together
      if (autoForgeState[username].awaitingConfirm) {
        const handsDist = calculateDistanceAutoForge(leftHand, rightHand);
        
        if (handsDist < 0.2) {
          // Hands together - confirmed!
          console.log(`[AUTO-FORGE] ${username} confirmed auto-forge`);
          
          // Check balance
          const balanceRes = await connection.send(`trade atm get "${username}"`);
          const balance = parseInt(balanceRes.data?.Result) || 0;
          
          console.log(`[AUTO-FORGE] ${username} balance: ${balance}`, balanceRes.data);
          
          if (balance >= AUTO_FORGE_COST) {
            // Deduct payment
            await connection.send(`trade atm add "${username}" -${AUTO_FORGE_COST}`);
            
            // Run auto-forge
            await connection.send(`progression forgeall "${username}"`);
            
            await connection.send(`player message "${username}" "✅ Auto-forge activated! -${AUTO_FORGE_COST} coins" 5`);
            console.log(`[AUTO-FORGE] ${username} paid ${AUTO_FORGE_COST} coins and started auto-forge`);
          } else {
            await connection.send(`player message "${username}" "❌ Insufficient funds! Need ${AUTO_FORGE_COST} coins, have ${balance}" 5`);
            console.log(`[AUTO-FORGE] ${username} insufficient funds: ${balance}/${AUTO_FORGE_COST}`);
          }
          
          autoForgeState[username].awaitingConfirm = false;
          autoForgeCooldowns[username] = now;
        }
      }
    }
  } catch (e) {
    console.error('[AUTO-FORGE ERROR]', e.message);
  }
}, 200); // Check 5 times per second

console.log('[AUTO-FORGE SYSTEM] Loaded successfully');
// ==================== END AUTO-FORGE SYSTEM ====================
// ==================== END TAVERN CONTROL SYSTEM ====================
  // Main loop
  setInterval(async () => {
    if (!activeConnection) return;

    try {
      const res = await activeConnection.send('player list-detailed');
      const players = res.data?.Result || [];

      for (const player of players) {
        const username = player.username;
        
        const leftUp = player.LeftHandUp;
        const rightUp = player.RightHandUp;
        const leftHand = player.LeftHandPosition;
        const rightHand = player.RightHandPosition;
        const headPos = player.HeadPosition;

        // Friend/Social item detection
        if (username && leftHand && rightHand && headPos) {
          const invRes = await activeConnection.send(`player inventory "${username}"`);
          const inv = invRes.data?.Result?.[0];
          
          if (inv) {
            const leftItem = (inv.LeftHand?.Name || "").toLowerCase();
            const rightItem = (inv.RightHand?.Name || "").toLowerCase();
            
            const holdingFriend = leftItem.includes("friend") || rightItem.includes("friend");
            const holdingSocial = leftItem.includes("social") || rightItem.includes("social");
            
            // FRIEND ITEM LOGIC
            if (holdingFriend) {
              if (!travelButtons[username]) {
                travelButtons[username] = { hadFriend: true };
              } else {
                travelButtons[username].hadFriend = true;
              }
              
              if (travelButtons[username]?.pos) {
                delete travelButtons[username].pos;
                delete travelButtons[username].expires;
              }
            } else {
              const hadFriend = travelButtons[username]?.hadFriend;
              
              if (hadFriend && !travelButtons[username]?.pos) {
                const buttonPos = leftHand;
                travelButtons[username] = {
                  pos: buttonPos,
                  expires: Date.now() + 300000,
                  hadFriend: false
                };
                buttonCooldowns[username] = false;
                await activeConnection.send(`player message "${username}" "📍 Travel button created!" 2`);
              }
              
              if (travelButtons[username]?.pos) {
                const button = travelButtons[username];
                
                if (Date.now() > button.expires) {
                  delete travelButtons[username];
                  delete buttonCooldowns[username];
                } else {
                  const buttonPos = button.pos;
                  const leftDist = getDistance(
                    leftHand[0], leftHand[1], leftHand[2],
                    buttonPos[0], buttonPos[1], buttonPos[2]
                  );
                  const rightDist = getDistance(
                    rightHand[0], rightHand[1], rightHand[2],
                    buttonPos[0], buttonPos[1], buttonPos[2]
                  );
                  
                  const threshold = 0.3;
                  const awayThreshold = 0.5;
                  const isNear = leftDist < threshold || rightDist < threshold;
                  const isAway = leftDist > awayThreshold && rightDist > awayThreshold;
                  
                  if (isAway && buttonCooldowns[username] === false) {
                    buttonCooldowns[username] = true;
                  }
                  
                  if (isNear && buttonCooldowns[username] === true) {
                    const onlineNames = players.map(p => p.username).filter(Boolean);
                    const msg = `🌍 Online: ${onlineNames.join(", ")}`;
                    await activeConnection.send(`player message "${username}" "${msg}" 2`);
                    buttonCooldowns[username] = false;
                  }
                }
              }
            }

            // SOCIAL ITEM LOGIC
            if (holdingSocial) {
              if (!socialButtons[username]) {
                socialButtons[username] = { hadSocial: true };
              } else {
                socialButtons[username].hadSocial = true;
              }
              
              if (socialButtons[username]?.pos) {
                delete socialButtons[username].pos;
                delete socialButtons[username].expires;
              }
            } else {
              const hadSocial = socialButtons[username]?.hadSocial;
              
              if (hadSocial && !socialButtons[username]?.pos) {
                const handPos = leftHand;
                const headToHand = [
                  handPos[0] - headPos[0],
                  handPos[1] - headPos[1],
                  handPos[2] - headPos[2]
                ];
                const distance = Math.sqrt(headToHand[0]**2 + headToHand[1]**2 + headToHand[2]**2);
                const normalized = [
                  headToHand[0] / distance,
                  headToHand[1] / distance,
                  headToHand[2] / distance
                ];
                const buttonPos = [
                  handPos[0] + normalized[0] * 0.5,
                  handPos[1] + normalized[1] * 0.5,
                  handPos[2] + normalized[2] * 0.5
                ];
                
                socialButtons[username] = {
                  pos: buttonPos,
                  expires: Date.now() + 300000,
                  hadSocial: false
                };
                socialCooldowns[username] = false;
                await activeConnection.send(`player message "${username}" "📊 Social button created!" 2`);
              }
              
              if (socialButtons[username]?.pos) {
                const button = socialButtons[username];
                
                if (Date.now() > button.expires) {
                  delete socialButtons[username];
                  delete socialCooldowns[username];
                } else {
                  const buttonPos = button.pos;
                  const leftDist = getDistance(
                    leftHand[0], leftHand[1], leftHand[2],
                    buttonPos[0], buttonPos[1], buttonPos[2]
                  );
                  const rightDist = getDistance(
                    rightHand[0], rightHand[1], rightHand[2],
                    buttonPos[0], buttonPos[1], buttonPos[2]
                  );
                  
                  const threshold = 0.6;
                  const awayThreshold = 0.9;
                  const isNear = leftDist < threshold || rightDist < threshold;
                  const isAway = leftDist > awayThreshold && rightDist > awayThreshold;
                  
                  if (isAway && socialCooldowns[username] === false) {
                    socialCooldowns[username] = true;
                  }
                  
                  if (isNear && socialCooldowns[username] === true) {
                    const statsRes = await activeConnection.send(`player list-stats "${username}"`);
                    const statsArray = statsRes.data?.Result || [];
                    
                    if (statsArray.length > 0) {
                      const statMap = {};
                      for (const stat of statsArray) {
                        statMap[stat.Name.toLowerCase()] = stat.Value;
                      }
                      
                      const hp = statMap['health'] || 0;
                      const hunger = statMap['hunger'] || 0;
                      const speed = statMap['speed'] || 0;
                      
                      const msg = `📊 ${username}\nHP: ${hp}\nHunger: ${hunger}\nSpeed: ${speed}`;
                      await activeConnection.send(`player message "${username}" "${msg}" 3`);
                    }
                    
                    socialCooldowns[username] = false;
                  }
                }
              }
            }
          }
        }

        // Gesture detection (only for authorized users who picked up smelter gem 1)
        if (!authorizedUsers.has(username)) continue;

        if (username && leftUp && rightUp && leftHand && rightHand && headPos) {
          const faceGesture = checkFaceGestures(username, leftUp, rightUp, leftHand, rightHand, headPos);
          
          if (faceGesture) {
            const now = Date.now();
            if (!lastGestureTime[username] || now - lastGestureTime[username] > GESTURE_COOLDOWN) {
              lastGestureTime[username] = now;

              if (faceGesture === 'toggle') {
                gesturesEnabled[username] = !gesturesEnabled[username];
                const status = gesturesEnabled[username] ? 'enabled ✅' : 'disabled ❌';
                await activeConnection.send(`player message "${username}" "Gestures ${status}" 3`);
                continue;
              }

              if (!gesturesEnabled[username]) continue;

              switch (faceGesture) {
                case 'damage':
                  await activeConnection.send(`player modify-stat "${username}" damage 99 500`);
                  await activeConnection.send(`player message "${username}" "💥 Damage applied!" 3`);
                  break;
                case 'speed':
                  await activeConnection.send(`player modify-stat "${username}" Speed 6 500`);
                  await activeConnection.send(`player message "${username}" "⚡ Speed boost activated!" 3`);
                  break;
                case 'hunger':
                  await activeConnection.send(`player setstat "${username}" Hunger 30`);
                  await activeConnection.send(`player message "${username}" "🍖 Hunger applied!" 3`);
                  break;
                case 'godmode':
                  await activeConnection.send(`player god-mode "${username}" true`);
                  await activeConnection.send(`player message "${username}" "🛡️ God mode activated!" 3`);
                  break;
              }
              continue;
            }
          }

          if (!gesturesEnabled[username]) continue;

          const handGesture = await checkHandGestures(username, leftUp, rightUp, leftHand, rightHand);
          
          if (handGesture) {
            const now = Date.now();
            if (!lastGestureTime[username] || now - lastGestureTime[username] > GESTURE_COOLDOWN) {
              lastGestureTime[username] = now;

              const invRes = await activeConnection.send(`player inventory "${username}"`);
              const inv = invRes.data?.Result?.[0];
              if (!inv) continue;

              if (handGesture === 'replace') {
                if (inv.LeftHand?.Identifier) {
                  await activeConnection.send(`wacky replace "${inv.LeftHand.Identifier}"`);
                }
                if (inv.RightHand?.Identifier) {
                  await activeConnection.send(`wacky replace "${inv.RightHand.Identifier}"`);
                }
              } else if (handGesture === 'delete') {
                if (inv.LeftHand?.Identifier) {
                  await activeConnection.send(`wacky destroy "${inv.LeftHand.Identifier}"`);
                }
                if (inv.RightHand?.Identifier) {
                  await activeConnection.send(`wacky destroy "${inv.RightHand.Identifier}"`);
                }
                await activeConnection.send(`player message "${username}" "🗑️ Items deleted!" 3`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[GESTURE ERROR]", err);
    }
  }, 500);
});

startBot();