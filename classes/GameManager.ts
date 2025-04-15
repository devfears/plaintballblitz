import {
  GameServer,
  Player,
  Quaternion,
  Vector3Like,
  World,
} from 'hytopia';

import worldMap from '../assets/map.json';

import {
  BEDROCK_BLOCK_ID,
  GAME_DURATION_MS,
  ITEM_SPAWNS,
  ITEM_SPAWNS_AT_START,
  ITEM_SPAWN_ITEMS,
  MINIMUM_PLAYERS_TO_START,
  SPAWN_REGION_AABB,
  RANK_WIN_EXP,
} from '../gameConfig';

import GamePlayerEntity from './GamePlayerEntity';
import ItemFactory from './ItemFactory';
import ItemEntity from './ItemEntity';
import PickaxeEntity from './weapons/PickaxeEntity'; // Corrected path

export default class GameManager {
  public static readonly instance = new GameManager();

  public world: World | undefined;
  private _gameStartAt: number = 0;
  private _gameTimer: NodeJS.Timeout | undefined;
  private _playerCount: number = 0;
  private _restartTimer: NodeJS.Timeout | undefined;
  private _killCounter: Map<string, number> = new Map();
  private _gameActive: boolean = false;
  private _isWaitingForPlayers: boolean = false;
  private _countdownTimer: NodeJS.Timeout | undefined;
  private _countdownSeconds: number = 10;
  private _isCountingDown: boolean = false;

  public get isGameActive(): boolean { return this._gameActive; }
  public get isCountingDown(): boolean { return this._isCountingDown; }

  public get playerCount(): number { return this._playerCount; }
  public set playerCount(value: number) {
    this._playerCount = value;
    this._updatePlayerCountUI();
  }

  /**
   * Sets up the game world and waits for players to join
   */
  public setupGame(world: World) {
    this.world = world;
    this._spawnBedrock(world);
  }

  /**
   * Handles player joining, increments count, and checks if game should start.
   */
  public async handlePlayerJoined(player: Player): Promise<void> {
    if (!this.world) return;

    console.log(`>>> [GameManager] handlePlayerJoined: Player ${player.username} joined. Current playerCount (before increment): ${this.playerCount}, gameActive: ${this._gameActive}, isCountingDown: ${this._isCountingDown}`);

    await this.spawnPlayerEntity(player); // Await spawn completion (includes UI load)
    this.playerCount++; // Increment count
    console.log(`>>> [GameManager] handlePlayerJoined: playerCount incremented to ${this.playerCount}`);
    
    // Update player count UI for all players
    this._updatePlayerCountUI();

    // If a player joins DURING the countdown, reset the countdown
    if (this._isCountingDown) {
      console.log(`>>> [GameManager] handlePlayerJoined: Player joined during countdown. Resetting timer.`);
      this._startCountdown(); // Reset and restart countdown
      return; // Don't proceed to other checks
    }

    // Check if we should start the game check sequence ONLY if the game isn't active
    // and we aren't already waiting or counting down.
    if (!this._gameActive && !this._isWaitingForPlayers && !this._isCountingDown) {
      console.log(`>>> [GameManager] handlePlayerJoined: Game not active/counting down, initiating _waitForPlayersToStart sequence.`);
      this._isWaitingForPlayers = true;
      this._waitForPlayersToStart(); 
    } else {
      console.log(`>>> [GameManager] handlePlayerJoined: Game is already active, waiting for players, or counting down. Not starting new wait sequence.`);
    }
  }

  /**
   * Starts the game when enough players have joined
   */
  public startGame(): void {
    if (!this.world) return;

    console.log(`>>> [GameManager] startGame: Attempting to start game...`);
    
    if (this._gameActive) return;
    
    // Clear countdown state
    this._isCountingDown = false;
    this._isWaitingForPlayers = false;
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    this._sendCountdownUpdateToAll(0, false); // Hide countdown for all

    // Clear any previous game state
    this._killCounter.clear();
    
    this._gameActive = true;
    this._gameStartAt = Date.now();
    
    // Set end timer
    this._gameTimer = setTimeout(() => {
      this.endGame();
    }, GAME_DURATION_MS);
    
    // Give all players a pistol
    const players = GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world);
    players.forEach(player => {
      // Find the player entity
      const playerEntities = this.world!.entityManager.getAllPlayerEntities();
      const gamePlayerEntity = playerEntities.find(entity => entity instanceof GamePlayerEntity && entity.player.username === player.username) as GamePlayerEntity | undefined;
      
      if (gamePlayerEntity) {
          console.log(`>>> [GameManager] startGame: Giving custom-gun to ${player.username}`);
          // Ensure the gun giving method is called
          gamePlayerEntity["_giveStartingGun"](); // Use bracket notation for private method access
      } else {
        console.error(`>>> [GameManager] startGame: Could not find GamePlayerEntity for ${player.username}`);
      }
    });
    
    console.log(`>>> [GameManager] startGame: Finished giving guns, now syncing UI.`);
    
    // Send UI start events and sync leaderboard for all players
    this._syncAllPlayersUI();
    
    // Send player count update
    this._updatePlayerCountUI();
    
    // Send start announcements to all players
    players.forEach(player => {
      this._sendGameStartAnnouncements(player);
    });
  }

  /**
   * Ends the current game round and schedules the next one
   */
  public endGame() {
    if (!this.world || !this._gameActive) return;
    
    this._gameActive = false;
    this.world.chatManager.sendBroadcastMessage('Game over! Starting the next round in 10 seconds...', 'FF0000');
    
    this._identifyWinningPlayer();

    // Clear any existing restart timer
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
    }
    
    // Reset state for next round start
    this._isWaitingForPlayers = true;
    this._isCountingDown = false; // Ensure countdown isn't active
    this._playerCount = GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world).length; // Recalculate count
    this._updatePlayerCountUI();

    // Reset timer will call _waitForPlayersToStart eventually
    this._restartTimer = setTimeout(() => {
        console.log(">>> [GameManager] Restart timer elapsed. Checking if enough players to start...");
        this._waitForPlayersToStart(); // Start the check loop again
    }, 10 * 1000);
  }

  /**
   * Spawns a player entity in the world
   */
  public async spawnPlayerEntity(player: Player): Promise<void> {
    if (!this.world) return;

    const playerEntity = new GamePlayerEntity(player);
    
    await playerEntity.spawn(this.world, this.getRandomSpawnPosition());
    console.log(`>>> [GameManager] spawnPlayerEntity: Finished awaiting spawn for ${player.username}`);
  
    // Sync UI for the new player (AFTER spawn/UI load)
    this.syncTimer(player); 
    this.syncLeaderboard(player);

    // If game is active OR counting down, send relevant UI state
    if (this._gameActive) {
      this._sendGameStartAnnouncements(player);
    } else if (this._isCountingDown) {
      // Send current countdown state to the joining player
      player.ui.sendData({ type: 'countdown-update', seconds: this._countdownSeconds, show: true });
    }

    // Load player's data
    await playerEntity.loadPersistedData(); // Ensure data is loaded
  }

  /**
   * Increments kill count for a player and updates the leaderboard
   */
  public addKill(playerUsername: string): void {
    const killCount = this._killCounter.get(playerUsername) ?? 0;
    const newKillCount = killCount + 1;
    
    this._killCounter.set(playerUsername, newKillCount);
    this._updateLeaderboardUI(playerUsername, newKillCount);
  }

  /**
   * Gets a random spawn position within the defined spawn region
   */
  public getRandomSpawnPosition(): Vector3Like {
    return {
      x: SPAWN_REGION_AABB.min.x + Math.random() * (SPAWN_REGION_AABB.max.x - SPAWN_REGION_AABB.min.x),
      y: SPAWN_REGION_AABB.min.y + Math.random() * (SPAWN_REGION_AABB.max.y - SPAWN_REGION_AABB.min.y),
      z: SPAWN_REGION_AABB.min.z + Math.random() * (SPAWN_REGION_AABB.max.z - SPAWN_REGION_AABB.min.z),
    };
  }

  /**
   * Returns the current kill counts for all players
   */
  public getKillCounts(): Record<string, number> {
    return Object.fromEntries(this._killCounter);
  }

  /**
   * Syncs the leaderboard UI for a specific player
   */
  public syncLeaderboard(player: Player) {
    if (!this.world) return;

    player.ui.sendData({
      type: 'leaderboard-sync',
      killCounts: this.getKillCounts(),
    });
  }

  /**
   * Syncs the game timer UI for a specific player
   */
  public syncTimer(player: Player) {
    console.log(`>>> [GameManager] syncTimer: Syncing timer for ${player.username}. Game started at: ${this._gameStartAt}`);
    if (!this.world || !this._gameStartAt) {
        console.log(`>>> [GameManager] syncTimer: World or game start time not available, skipping sync for ${player.username}.`);
        return;
    }

    const syncData = {
      type: 'timer-sync',
      startedAt: this._gameStartAt,
      endsAt: this._gameStartAt + GAME_DURATION_MS,
    };
    console.log(`>>> [GameManager] syncTimer: Sending timer data to ${player.username}:`, syncData);
    player.ui.sendData(syncData);
  }

  /**
   * Resets the leaderboard and syncs it for all players
   */
  public resetLeaderboard() {
    if (!this.world) return;

    this._killCounter.clear();
    
    GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world).forEach(player => {
      this.syncLeaderboard(player);
    });
  }

  public _identifyWinningPlayer() {
    if (!this.world) return;

    // Find player with most kills
    let highestKills = 0;
    let winningPlayer = '';
    
    this._killCounter.forEach((kills, player) => {
      if (kills > highestKills) {
        highestKills = kills;
        winningPlayer = player;
      }
    });

    // Get winning player entity
    const winningPlayerEntity = this.world.entityManager
      .getAllPlayerEntities()
      .find(entity => entity.player.username === winningPlayer);

    if (!winningPlayerEntity) return;

    // Give winning player XP for winning
    if (winningPlayerEntity instanceof GamePlayerEntity) {
      winningPlayerEntity.addExp(RANK_WIN_EXP);
    }

    this.world.entityManager.getAllPlayerEntities().forEach(playerEntity => {
      if (playerEntity instanceof GamePlayerEntity) {
        if (playerEntity.player.username !== winningPlayer) { // don't change camera for the winner
          playerEntity.focusCameraOnPlayer(winningPlayerEntity as GamePlayerEntity);
        }
          
        playerEntity.player.ui.sendData({
          type: 'announce-winner',
          username: winningPlayer,
        });
      }
    });
  }

  /**
   * Syncs UI for all connected players
   */
  private _syncAllPlayersUI() {
    console.log(`>>> [GameManager] _syncAllPlayersUI: Attempting to sync UI for all players...`);
    if (!this.world) return;
    
    const players = GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world);
    console.log(`>>> [GameManager] _syncAllPlayersUI: Found ${players.length} players to sync.`);
    players.forEach(player => {
      this.syncTimer(player);
      this.syncLeaderboard(player);
    });
  }

  /**
   * Sends game start announcements to a specific player
   */
  private _sendGameStartAnnouncements(player: Player) {
    if (!this.world) return;
    
    this.world.chatManager.sendPlayerMessage(player, 'Game started - most kills wins!', '00FF00');
    this.world.chatManager.sendPlayerMessage(player, '- Search for chests and weapons to survive');
    this.world.chatManager.sendPlayerMessage(player, '- Break blocks with your pickaxe to gain materials');
    this.world.chatManager.sendPlayerMessage(player, '- Right click to spend 3 materials to place a block');
    this.world.chatManager.sendPlayerMessage(player, '- Some weapons zoom with "Z". Drop items with "Q"');
  }

  /**
   * Creates bedrock floor for the game world
   */
  private _spawnBedrock(world: World) {
    for (let x = -50; x <= 50; x++) {
      for (let z = -50; z <= 50; z++) {
        world.chunkLattice.setBlock({ x, y: -1, z }, BEDROCK_BLOCK_ID);
      }
    }
  }

  /**
   * Spawns initial items at random positions
   */
  private _spawnStartingItems() {
    if (!this.world) return;
    
    // If there are no items configured to spawn, just exit.
    if (ITEM_SPAWN_ITEMS.length === 0) {
      return;
    }
    
    const shuffledItemSpawns = [...ITEM_SPAWNS].sort(() => Math.random() - 0.5);
    const selectedItemSpawns = shuffledItemSpawns.slice(0, ITEM_SPAWNS_AT_START);
    const totalWeight = ITEM_SPAWN_ITEMS.reduce((sum, item) => sum + item.pickWeight, 0);

    selectedItemSpawns.forEach(async spawn => {
      // Select random item based on weight
      let random = Math.random() * totalWeight;
      let selectedItem = ITEM_SPAWN_ITEMS[0];
      
      for (const item of ITEM_SPAWN_ITEMS) {
        random -= item.pickWeight;
        if (random <= 0) {
          selectedItem = item;
          break;
        }
      }

      const item = await ItemFactory.createItem(selectedItem.itemId);
      item.spawn(this.world!, spawn.position, Quaternion.fromEuler(0, Math.random() * 360 - 180, 0));
    });
  }

  /**
   * Updates the leaderboard UI for all players
   */
  private _updateLeaderboardUI(username: string, killCount: number) {
    if (!this.world) return;

    GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world).forEach(player => {
      player.ui.sendData({
        type: 'leaderboard-update',
        username,
        killCount,
      });
    });
  }

  private _updatePlayerCountUI() {
    if (!this.world) return;

    console.log(`>>> [GameManager] _updatePlayerCountUI: Updating player count UI to ${this.playerCount}`);
    
    // Get connected players and send them the player count
    const players = GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world);
    players.forEach(player => {
      player.ui.sendData({ 
        type: 'players-count', 
        count: this.playerCount 
      });
    });
  }

  /**
   * Waits for enough players to join before starting the countdown
   */
  private _waitForPlayersToStart() {
    if (!this._isWaitingForPlayers || this._isCountingDown || this._gameActive) {
      console.log(`>>> [GameManager] _waitForPlayersToStart: Condition not met (waiting: ${this._isWaitingForPlayers}, counting: ${this._isCountingDown}, active: ${this._gameActive}). Stopping check loop.`);
      this._isWaitingForPlayers = false; // Stop waiting if conditions change
      return; 
    }
    
    if (!this.world) return;

    const connectedPlayers = GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world).length;
    console.log(`>>> [GameManager] _waitForPlayersToStart: Checking start condition. Found ${connectedPlayers} connected players. Minimum needed: ${MINIMUM_PLAYERS_TO_START}`);

    if (connectedPlayers >= MINIMUM_PLAYERS_TO_START) {
      console.log(`>>> [GameManager] _waitForPlayersToStart: Player count met or exceeded. Starting countdown.`);
      this._isWaitingForPlayers = false; // Stop waiting, start counting down
      this._startCountdown();
    } else {
      console.log(`>>> [GameManager] _waitForPlayersToStart: Player count not met. Waiting 1 second...`);
      // Re-check after a delay only if still waiting
      setTimeout(() => {
        if (this._isWaitingForPlayers) { 
          this._waitForPlayersToStart(); 
        }
      }, 1000);
    }
  }

  /**
   * Starts the 10-second countdown before the game begins.
   */
  private _startCountdown() {
    if (this._isCountingDown) {
      // Clear existing timer if restarting
      console.log(`>>> [GameManager] _startCountdown: Clearing existing countdown timer.`);
      clearTimeout(this._countdownTimer);
    }
    
    console.log(`>>> [GameManager] _startCountdown: Starting 10 second countdown.`);
    this._isCountingDown = true;
    this._countdownSeconds = 10; // Reset to 10 seconds
    this._sendCountdownUpdateToAll(this._countdownSeconds, true); // Show timer for all

    this._countdownTimer = setInterval(() => {
      this._countdownSeconds--;
      console.log(`>>> [GameManager] Countdown: ${this._countdownSeconds}`);
      this._sendCountdownUpdateToAll(this._countdownSeconds, true);

      if (this._countdownSeconds <= 0) {
        console.log(`>>> [GameManager] Countdown finished. Starting game.`);
        clearInterval(this._countdownTimer); 
        this._isCountingDown = false;
        this.startGame(); // Start the game
      }
    }, 1000);
  }

  /**
   * Sends the current countdown state to all connected players.
   */
  private _sendCountdownUpdateToAll(seconds: number, show: boolean) {
    if (!this.world) return;
    console.log(`>>> [GameManager] _sendCountdownUpdateToAll: Sending seconds=${seconds}, show=${show}`);
    const players = GameServer.instance.playerManager.getConnectedPlayersByWorld(this.world);
    players.forEach(player => {
      player.ui.sendData({ type: 'countdown-update', seconds, show });
    });
  }
}