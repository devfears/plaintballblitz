import { 
  Audio,
  BaseEntityControllerEvent,
  EventPayloads,
  Player,
  PlayerEntity,
  PlayerCameraMode,
  Vector3Like,
  QuaternionLike,
  World,
  PlayerEntityController,
  PlayerUIEvent,
  SceneUI,
  ErrorHandler,
} from 'hytopia';

import ChestEntity from './ChestEntity';
import GunEntity from './GunEntity';
import ItemEntity from './ItemEntity';
import PickaxeEntity from './weapons/PickaxeEntity';
import MeleeWeaponEntity from './MeleeWeaponEntity';
import ItemFactory from './ItemFactory';
import { BUILD_BLOCK_ID, RANKS, RANK_KILL_EXP, RANK_SAVE_INTERVAL_EXP } from '../gameConfig';
import GameManager from './GameManager';

const BASE_HEALTH = 100;
const BASE_SHIELD = 0;
const BLOCK_MATERIAL_COST = 3;
const INTERACT_RANGE = 4;
const MAX_HEALTH = 100;
const MAX_SHIELD = 100;
const TOTAL_INVENTORY_SLOTS = 6;

interface InventoryItem {
  name: string;
  iconImageUri: string;
  quantity: number;
}

interface PlayerPersistedData extends Record<string, unknown> {
  totalExp: number
}

export default class GamePlayerEntity extends PlayerEntity {
  private readonly _damageAudio: Audio;
  private readonly _inventory: (ItemEntity | undefined)[] = new Array(TOTAL_INVENTORY_SLOTS).fill(undefined);
  private _dead: boolean = false;
  private _health: number = BASE_HEALTH;
  private _inventoryActiveSlotIndex: number = 0;
  private _lastExpSave: number = 0;
  private _maxHealth: number = MAX_HEALTH;
  private _maxShield: number = MAX_SHIELD;
  private _rankIndex: number = 0;
  private _rankSceneUI: SceneUI;
  private _respawnTimer: NodeJS.Timeout | undefined;
  private _shield: number = BASE_SHIELD;
  private _totalExp: number = 0;

  // Player entities always assign a PlayerController to the entity
  public get playerController(): PlayerEntityController {
    return this.controller as PlayerEntityController;
  }

  public get health(): number { return this._health; }
  public set health(value: number) {
    this._health = Math.max(0, Math.min(value, this._maxHealth));
    this._updatePlayerUIHealth();
  }

  public get shield(): number { return this._shield; }
  public set shield(value: number) {
    this._shield = Math.max(0, Math.min(value, this._maxShield));
    this._updatePlayerUIShield();
  }

  public get maxHealth(): number { return this._maxHealth; }
  public get maxShield(): number { return this._maxShield; }

  public get isDead(): boolean { return this._dead; }

  public constructor(player: Player) {
    super({
      player,
      name: 'Player',
      modelUri: 'models/players/soldier-player.gltf',
      modelScale: 0.5,
    });
    
    this._setupPlayerController();
    this._setupPlayerUI();
    this._setupPlayerCamera();
    this._setupPlayerHeadshotCollider();
    
    this._rankSceneUI = new SceneUI({
      attachedToEntity: this,
      templateId: 'player-rank',
      state: { iconUri: 'icons/ranks/unranked.png' },
      viewDistance: 8,
      offset: { x: 0, y: 1.15, z: 0 },
    });

    this._damageAudio = new Audio({
      attachedToEntity: this,
      uri: 'audio/sfx/player-hurt.mp3',
      loop: false,
      volume: 0.7,
    });
  }

  public override async spawn(world: World, position: Vector3Like, rotation?: QuaternionLike): Promise<void> {
    super.spawn(world, position, rotation);
    
    // Setup inventory (sync for now, but await is good practice)
    this._setupPlayerInventory(); 
    
    // Await the UI setup 
    await this._setupPlayerUI(); 
    
    // Set active slot AFTER inventory/UI is set up
    this.setActiveInventorySlotIndex(0);
    // Ensure initial UI state for the active slot is correct
    this._updatePlayerUIInventoryActiveSlot(); 
    
    // Start tickers
    this._autoHealTicker();
    this._outOfWorldTicker();
    
    // Initial UI updates after UI is loaded
    this._updatePlayerUIHealth();
    this._updatePlayerUIInventory(); 

    // Load scene UI
    this._rankSceneUI.load(world);
    console.log(`>>> [${this.player.username}] spawn: Spawn method completed.`);
  }

  public addExp(exp: number): void {
    this._totalExp += exp;
    this._updatePlayerUIExp();

    // Save the player's data to persisted storage every so often.
    if (this._totalExp - this._lastExpSave >= RANK_SAVE_INTERVAL_EXP) {
      this.savePersistedData();
      this._lastExpSave = this._totalExp;
    }
  }

  public addItemToInventory(item: ItemEntity): void {
    const slot = this._findInventorySlot();

    if (slot === this._inventoryActiveSlotIndex) {
      this.dropActiveInventoryItem();
    }

    this._inventory[slot] = item;
    this._updatePlayerUIInventory();
    this._updatePlayerUIInventoryActiveSlot();
    this.setActiveInventorySlotIndex(this._inventoryActiveSlotIndex);
  }

  public checkDeath(attacker?: GamePlayerEntity): void {
    if (this.health <= 0) {
      this._dead = true;

      if (attacker) {
        GameManager.instance.addKill(attacker.player.username);
        attacker.addExp(RANK_KILL_EXP);
        this.focusCameraOnPlayer(attacker);
      }

      this.dropAllInventoryItems();

      if (this.isSpawned && this.world) {
        // reset player inputs
        Object.keys(this.player.input).forEach(key => {
          this.player.input[key] = false;
        });

        this.playerController.idleLoopedAnimations = [ 'sleep' ];
        this.world.chatManager.sendPlayerMessage(this.player, 'You have died! Respawning in 5 seconds...', 'FF0000');
        this._respawnTimer = setTimeout(() => this.respawn(), 5 * 1000);

        if (attacker) {
          if (this.player.username !== attacker.player.username) {
            this.world.chatManager.sendBroadcastMessage(`${attacker.player.username} killed ${this.player.username} with a ${attacker.getActiveItemName()}!`, 'FF0000');
          } else {
            this.world.chatManager.sendBroadcastMessage(`${this.player.username} self-destructed!`, 'FF0000');
          }
        }
      }
    }
  }

  public focusCameraOnPlayer(player: GamePlayerEntity): void {
    this.player.camera.setMode(PlayerCameraMode.THIRD_PERSON);
    this.player.camera.setAttachedToEntity(player);
    this.player.camera.setModelHiddenNodes([]);
  }

  public dealtDamage(damage: number): void {
    this.player.ui.sendData({
      type: 'show-damage',
      damage,
    });
  }
  
  public dropActiveInventoryItem(): void {
    if (this._inventoryActiveSlotIndex === 0) {
      this.world?.chatManager?.sendPlayerMessage(this.player, 'You cannot drop your pickaxe!');
      return;
    }

    const item = this._inventory[this._inventoryActiveSlotIndex];
    if (!item) return;

    item.unequip();
    item.drop(this.position, this.player.camera.facingDirection);
    this._inventory[this._inventoryActiveSlotIndex] = undefined;
    this._updatePlayerUIInventory();
    this._updatePlayerUIInventoryActiveSlot();
  }

  public dropAllInventoryItems(): void {
    // skip 0 (pickaxe) and 1 (gun), we cannot drop these
    for (let i = 2; i < this._inventory.length; i++) {
      const item = this._inventory[i];
      if (!item) continue;

      item.unequip();
      item.drop(this.position, this.player.camera.facingDirection);
      this._inventory[i] = undefined;
    }

    this._updatePlayerUIInventory();
  }

  public getActiveItemName(): string {
    const activeItem = this._inventory[this._inventoryActiveSlotIndex];
    if (!activeItem) return '';

    return activeItem.name;
  }

  public getItemInventorySlot(item: ItemEntity): number {
    return this._inventory.findIndex(slot => slot === item);
  }

  public isItemActiveInInventory(item: ItemEntity): boolean {
    return this._inventory[this._inventoryActiveSlotIndex] === item;
  }

  public async loadPersistedData(): Promise<void> {
    if (!this.isSpawned) {
      return ErrorHandler.error('PlayerEntity not spawned');
    }

    const data = await this.player.getPersistedData();

    if (data) {
      const persistedData = data as unknown as PlayerPersistedData;

      this._lastExpSave = persistedData.totalExp;
      this._totalExp = persistedData.totalExp;
    }

    this._updatePlayerUIExp();
  }

  public resetAnimations(): void {
    this.playerController.idleLoopedAnimations = ['idle_lower', 'idle_upper'];
    this.playerController.interactOneshotAnimations = [];
    this.playerController.walkLoopedAnimations = ['walk_lower', 'walk_upper'];
    this.playerController.runLoopedAnimations = ['run_lower', 'run_upper'];
  }

  public resetCamera(): void {
    this._setupPlayerCamera();
    this.player.camera.setAttachedToEntity(this);
  }

  public respawn(): void {
    if (!this.world) return;

    this._dead = false;
    this.health = this._maxHealth;
    this.shield = 0;
    this.resetAnimations();
    this.player.camera.setAttachedToEntity(this);
    this._setupPlayerCamera();
    this.setActiveInventorySlotIndex(0);
    this.setPosition(GameManager.instance.getRandomSpawnPosition());

    // Give the player their starting gun again
    this._giveStartingGun();
  }

  public savePersistedData(): void {
    let data: PlayerPersistedData = {
      totalExp: this._totalExp,
    };

    this.player.setPersistedData(data);
  }

  public setActiveInventorySlotIndex(index: number): void {
    if (index !== this._inventoryActiveSlotIndex) {
      this._inventory[this._inventoryActiveSlotIndex]?.unequip();
    }

    this._inventoryActiveSlotIndex = index;

    if (this._inventory[index]) {
      this._inventory[index].equip();
    }

    this._updatePlayerUIInventoryActiveSlot();
  }

  public setGravity(gravityScale: number): void {
    this.setGravityScale(gravityScale);
  }

  public takeDamage(damage: number, hitDirection: Vector3Like, attacker?: GamePlayerEntity): void {
    if (!this.isSpawned || !this.world || !GameManager.instance.isGameActive || this._dead) return;

    this._playDamageAudio();

    // Flash for damage
    this.setTintColor({ r: 255, g: 0, b: 0});
    setTimeout(() => this.setTintColor({ r: 255, g: 255, b: 255 }), 100); // reset tint color after 100ms

    // Convert hit direction to screen space coordinates
    const facingDir = this.player.camera.facingDirection;
    this.player.ui.sendData({
      type: 'damage-indicator', 
      direction: {
        x: -(facingDir.x * hitDirection.z - facingDir.z * hitDirection.x),
        y: 0,
        z: -(facingDir.x * hitDirection.x + facingDir.z * hitDirection.z)
      }
    });

    // Handle shield damage first
    if (this.shield > 0) {
      const shieldDamage = Math.min(damage, this.shield);
      this.shield -= shieldDamage;
      damage -= shieldDamage;      
      if (damage === 0) return;
    }

    // Handle health damage
    this.health -= damage;
    this.checkDeath(attacker);
  }

  public updateHealth(amount: number): void {
    this.health = Math.min(this.health + amount, this._maxHealth);

    this._updatePlayerUIHealth();
  }

  public updateShield(amount: number): void {
    this.shield = Math.min(this.shield + amount, this._maxShield);

    this._updatePlayerUIShield();
  }

  public updateItemInventoryQuantity(item: ItemEntity): void {
    const index = this.getItemInventorySlot(item);
    if (index === -1) return;

    this.player.ui.sendData({
      type: 'inventory-quantity-update',
      index,
      quantity: item.getQuantity(),
    });
  }

  private _setupPlayerController(): void {
    // Make the controller not automatically cancel left click input
    // So we can handle it ourselves for shooting, etc.
    this.playerController.autoCancelMouseLeftClick = false;

    // Set custom movement speeds
    this.playerController.walkVelocity = 6; // Set walk speed to 6
    this.playerController.runVelocity = 18; // Set run speed to 18

    // Reset animations to defaults initially
    this.resetAnimations();

    this.playerController.on(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT, this._onTickWithPlayerInput);
  }

  private _setupPlayerHeadshotCollider(): void {
    // TODO
    // this.createAndAddChildCollider({
    //   shape: ColliderShape.BALL,
    //   radius: 0.45,
    //   relativePosition: { x: 0, y: 0.4, z: 0 },
    //   isSensor: true,
    // });
  }

  private _setupPlayerInventory(): void {
    // Give Pickaxe in slot 0
    const pickaxe = new PickaxeEntity();
    pickaxe.spawn(this.world!, this.position);
    pickaxe.pickup(this);

    // Give Custom Gun
    this._giveStartingGun();
  }

  /**
   * Gives the player the starting 'custom-gun'.
   */
  private async _giveStartingGun(): Promise<void> {
    if (!this.world) return;
    
    // Use an async IIFE (Immediately Invoked Function Expression) 
    // because ItemFactory.createItem is async
    (async () => {
      try {
        const customGun = await ItemFactory.createItem('custom-gun');
        if (customGun && customGun instanceof ItemEntity) {
          // Spawn the gun near the player initially (needed before pickup)
          customGun.spawn(this.world!, this.position);
          // Add the gun to the player's inventory (this handles placing it in the next available slot)
          customGun.pickup(this);
        } else {
          console.error('Failed to create or spawn CustomGunEntity for starting inventory.');
        }
      } catch (error) {
        console.error('Error creating CustomGunEntity for starting inventory:', error);
      }
    })();
  }

  private async _setupPlayerUI(): Promise<void> {
    this.nametagSceneUI.setViewDistance(8);
    try {
        await this.player.ui.load('ui/index.html');
        console.log(`>>> [${this.player.username}] _setupPlayerUI: UI loaded successfully.`);
    } catch (error) {
        console.error(`>>> [${this.player.username}] _setupPlayerUI: Error loading UI:`, error);
    }

    // Load rank data
    this.player.ui.sendData({
      type: 'ranks',
      ranks: RANKS,
    });

    // Handle inventory selection from mobile UI
    this.player.ui.on(PlayerUIEvent.DATA, (payload) => {
      const { data } = payload;

      if (data.type === 'inventory-select') {
        this.setActiveInventorySlotIndex(data.index);
      }
    });
  }

  private _setupPlayerCamera(): void {
    this.player.camera.setMode(PlayerCameraMode.FIRST_PERSON);
    this.player.camera.setModelHiddenNodes([ 'head', 'neck', 'torso', 'leg_right', 'leg_left' ]);
    this.player.camera.setOffset({ x: 0, y: 0.5, z: 0 });
  }

  private _onTickWithPlayerInput = (payload: EventPayloads[BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT]): void => {
    const { input } = payload;

    if (this._dead) {
      return;
    }

    if (input.ml) {
      this._handleMouseLeftClick();
    }

    if (input.mr) {
      this._handleMouseRightClick();
    }

    if (input.e) {
      this._handleInteract();
      input.e = false;
    }

    if (input.q) {
      this.dropActiveInventoryItem();
      input.q = false;
    }

    if (input.r) {
      this._handleReload();
      input.r = false;
    }

    if (input.z) {
      this._handleZoomScope();
      input.z = false;
    }

    this._handleInventoryHotkeys(input);
  }

  private _handleMouseLeftClick(): void {
    const activeItem = this._inventory[this._inventoryActiveSlotIndex];
 
    if (activeItem instanceof ItemEntity && activeItem.consumable) {
      activeItem.consume();
    }

    if (activeItem instanceof GunEntity) {
      activeItem.shoot();
    }

    if (activeItem instanceof MeleeWeaponEntity) {
      activeItem.attack();
    }
  }

  private _handleMouseRightClick(): void {
    // Right click is currently unassigned. 
    // Previously handled block placement raycasting.
  }

  private _handleReload(): void {
    const activeItem = this._inventory[this._inventoryActiveSlotIndex];
    if (activeItem instanceof GunEntity) {
      activeItem.reload();
    }
  }

  private _handleZoomScope(): void {
    const activeItem = this._inventory[this._inventoryActiveSlotIndex];
    if (activeItem instanceof GunEntity) {
      activeItem.zoomScope();
    }
  }

  private _handleInventoryHotkeys(input: any): void {
    if (input.f) {
      this.setActiveInventorySlotIndex(0);
      input.f = false;
    }

    for (let i = 1; i <= TOTAL_INVENTORY_SLOTS; i++) {
      const key = i.toString();
      if (input[key]) {
        this.setActiveInventorySlotIndex(i);
        input[key] = false;
      }
    }
  }

  private _handleInteract(): void {
    if (!this.world) return;

    const origin = {
      x: this.position.x,
      y: this.position.y + this.player.camera.offset.y,
      z: this.position.z,
    };
    
    const raycastHit = this.world.simulation.raycast(
      origin,
      this.player.camera.facingDirection,
      INTERACT_RANGE,
      {
        filterExcludeRigidBody: this.rawRigidBody,
        filterFlags: 8, // Rapier exclude sensors,
      }
    );

    const hitEntity = raycastHit?.hitEntity;

    if (hitEntity instanceof ChestEntity) {
      hitEntity.open();
    }

    if (hitEntity instanceof ItemEntity) {
      if (this._findInventorySlot() === 0) {
        this.world?.chatManager?.sendPlayerMessage(this.player, 'You cannot replace your pickaxe! Switch to a different item first to pick up this item.');
        return;
      }

      hitEntity.pickup(this);
    }
  }

  private _findInventorySlot(): number {
    // Try active slot first if empty
    if (!this._inventory[this._inventoryActiveSlotIndex]) {
      return this._inventoryActiveSlotIndex;
    }

    // Find first empty slot or use active slot if none found
    const emptySlot = this._inventory.findIndex(slot => !slot);

    return emptySlot !== -1 ? emptySlot : this._inventoryActiveSlotIndex;
  }

  private _updatePlayerUIInventory(): void {
    if (!this.player.ui) return;

    const inventoryData = this._inventory.map(item => {
      if (!item) return null; // Represent empty slot

      // Check if the item is the specific paintball gun (adjust name if needed)
      // Or add a property like 'hasInfiniteAmmo' to the gun entity itself
      const isInfiniteAmmo = item.name === 'Paintball Gun'; // Example check by name

      return {
        name: item.name,
        iconImageUri: item.iconImageUri,
        // Send 'Infinity' string or a special marker instead of quantity for infinite ammo
        quantity: isInfiniteAmmo ? 'Infinity' : item.getQuantity(), 
        isInfinite: isInfiniteAmmo // Add a flag for easier client-side check
      };
    });

    this.player.ui.sendData({
      type: 'inventory',
      inventory: inventoryData,
    });
  }

  private _updatePlayerUIInventoryActiveSlot(): void {
    this.player.ui.sendData({
      type: 'inventory-active-slot',
      index: this._inventoryActiveSlotIndex,
    });

    const activeItem = this._inventory[this._inventoryActiveSlotIndex];
    if (activeItem instanceof GunEntity) {
      activeItem.updateAmmoIndicatorUI();
    } else {
      this.player.ui.sendData({
        type: 'ammo-indicator',
        show: false,
      });
    }
  }

  private _updatePlayerUIHealth(): void {
    this.player.ui.sendData({
      type: 'health',
      health: this._health,
      maxHealth: this._maxHealth
    });
  }

  private _updatePlayerUIShield(): void {
    this.player.ui.sendData({
      type: 'shield',
      shield: this._shield,
      maxShield: this._maxShield,
    });
  }

  private _updatePlayerUIExp(): void {
    const rankIndex = this._totalExpToRankIndex(this._totalExp);

    if (rankIndex !== this._rankIndex) {
      this._rankIndex = rankIndex;

      this._rankSceneUI.setState({
        iconUri: RANKS[this._rankIndex].iconUri,
      });
    }

    this.player.ui.sendData({
      type: 'exp-update',
      totalExp: this._totalExp,
      rankIndex,
    });
  }

  private _playDamageAudio(): void {
    this._damageAudio.setDetune(-200 + Math.random() * 800);
    this._damageAudio.play(this.world!, true);
  }

  private _autoHealTicker(): void {
    setTimeout(() => {
      if (!this.isSpawned) return;

      if (this.health < this._maxHealth && !this._dead) {
        this.health += 1;
      }

      this._autoHealTicker();
    }, 2000);
  }

  private _outOfWorldTicker(): void {
    setTimeout(() => {
      if (!this.isSpawned) return;

      if (this.position.y < -100 && !this._dead) {
        this.takeDamage(MAX_HEALTH + MAX_SHIELD, { x: 0, y: 0, z: -1 });
      }

      this._outOfWorldTicker();
    }, 3000);
  }

  private _totalExpToRankIndex(totalExp: number): number {
    // Get the rank index for the player's total exp
    for (let i = 0; i < RANKS.length - 1; i++) {
      if (totalExp >= RANKS[i].totalExp && totalExp < RANKS[i + 1].totalExp) {
        return i;
      }
    }
    
    // If we've reached the highest rank
    if (totalExp >= RANKS[RANKS.length - 1].totalExp) {
      return RANKS.length - 1;
    }
    
    // Default to unranked (index 0) if below first rank
    return 0;
  }
}
