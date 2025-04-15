import { Quaternion, Vector3Like, QuaternionLike } from 'hytopia';
import GunEntity from '../GunEntity';
import type { GunEntityOptions } from '../GunEntity';
import GamePlayerEntity from '../GamePlayerEntity';

// Define default options for the Custom Gun, based on Pistol
const DEFAULT_CUSTOM_GUN_OPTIONS: GunEntityOptions = {
  ammo: 50, // Clip size
  damage: 10,
  fireRate: 15, // Increased fire rate
  heldHand: 'right',
  iconImageUri: 'icons/paintball-gun.png',
  idleAnimation: 'idle_gun_right',
  mlAnimation: 'shoot_gun_right',
  name: 'Paintball Gun',
  maxAmmo: 50, // Clip size
  totalAmmo: 999, // Keep high number for UI display logic (will show ∞)
  modelUri: 'models/items/gun.gltf',
  modelScale: 0.5,
  range: 25,
  reloadAudioUri: 'audio/sfx/pistol-reload.mp3', // Sound for cooldown
  reloadTimeMs: 1042, // Cooldown duration matching total animation time (542ms + 500ms)
  shootAudioUri: 'audio/sfx/pistol-shoot.mp3',
};

// Define the CustomGunEntity class
export default class CustomGunEntity extends GunEntity {
  // Need access to _reloading and _lastFireTime from base class
  // We redeclare them here, potentially needing to make them protected in GunEntity
  // For now, assuming we manage state locally or adjust base class later if needed.
  private _customReloading: boolean = false;
  private _customLastFireTime: number = 0;

  public constructor(options: Partial<GunEntityOptions> = {}) {
    // Initialize with default options, allowing overrides
    super({ ...DEFAULT_CUSTOM_GUN_OPTIONS, ...options });
  }

  // Override shoot to use custom processing
  public override shoot(): void {
    // Use custom processShoot logic
    if (!this.parent || !this.processShoot()) return;

    // Call base shoot functionality (handles projectile spawning, effects etc AFTER validation)
    super.shoot();
  }

  // Custom processShoot for infinite ammo clip logic
  protected override processShoot(): boolean {
    if (this._customReloading) return false; // Use custom flag

    const now = performance.now();
    // Use custom flag
    if (this._customLastFireTime && now - this._customLastFireTime < 1000 / this.fireRate) return false;

    if (this.ammo <= 0) {
      this.reload(); // Trigger reload/cooldown
      return false;
    }

    this.ammo--; // ONLY decrement clip ammo
    // DO NOT decrement totalAmmo
    this._customLastFireTime = now; // Use custom flag

    // We still need to update the UI indicator
    this.updateAmmoIndicatorUI();

    return true;
  }

  // Override reload to handle cooldown animation and clip reset for infinite ammo
  public override reload(): void {
    if (!this.parent?.world || this._customReloading || this.ammo > 0) {
      // Don't reload if already reloading, or if clip isn't empty
      return;
    }

    this._customReloading = true;
    
    // Play the "reload_off" animation FIRST when cooldown starts
    const reloadOffDuration = 542; // Duration from Blockbench
    const reloadOnDuration = 500;  // Duration from Blockbench
    const totalAnimationTime = reloadOffDuration + reloadOnDuration;
    
    console.log(`Starting reload_off animation (cooldown start, duration: ${reloadOffDuration}ms)`);
    this.startModelOneshotAnimations(['reload_off']);

    // Schedule "reload on" animation after "reload_off" finishes
    setTimeout(() => {
      if (this.isSpawned && this._customReloading) {
        console.log(`Playing reload on animation (duration: ${reloadOnDuration}ms)`);
        this.startModelOneshotAnimations(['reload on']);
      } else {
        console.log('Skipping reload on animation (not spawned or not reloading).');
      }
    }, reloadOffDuration);

    // Play reload sound
    // Ensure reloadAudio is accessible or manage sound playback here
    // Assuming _reloadAudio is protected or we add a method in base class
    // For now, let's assume we can access it or add playback logic if needed.
    try {
      // Attempt to play sound - requires _reloadAudio to be accessible
      // If _reloadAudio is private in GunEntity, this needs adjustment
      (this as any)._reloadAudio?.play(this.parent.world, true);
    } catch (e) {
      console.warn("Could not play reload audio, _reloadAudio might be private", e);
    }

    // Update UI to show reloading state
    this.updateAmmoIndicatorUI(true); 

    // Start timer for the *total* cooldown period (matching combined animation duration)
    setTimeout(() => this._finishReloadCustom(), totalAnimationTime); // Use totalAnimationTime
  }

  // Custom method to finish the reload/cooldown cycle
  private _finishReloadCustom(): void {
    if (!this.isSpawned || !this._customReloading) {
      // Stop if entity despawned or reload was somehow cancelled
      this._customReloading = false; // Ensure flag is reset
      return;
    }

    this._customReloading = false;
    this.ammo = this.maxAmmo; // Reset clip ammo to full (50)

    // Update UI to show new ammo count
    this.updateAmmoIndicatorUI(false);
  }

  // Override the equip method to set custom position and rotation when held
  public override equip(): void {
    // Call the base class equip method first
    super.equip(); 

    // --- Adjust these values for your gun model --- 
    // Position relative to the hand anchor point (x, y, z)
    // Try changing these values, save, and see the result in-game.
    this.setPosition({ x: 0, y: 0.1, z: 0 }); // Example: slightly raise it

    // Rotation relative to the hand anchor point (pitch, yaw, roll in degrees)
    // Common adjustments involve rotating around Y (yaw) and potentially X (pitch).
    // Reverting previous attempt. Trying -90 pitch (forward) and +90 roll to orient correctly in hand.
    this.setRotation(Quaternion.fromEuler(-90, 0, 90)); 
    // --- End of adjustments ---
  }

  // Define where the muzzle flash effect should appear relative to the gun model's origin
  public override getMuzzleFlashPositionRotation(): { position: Vector3Like, rotation: QuaternionLike } {
    // TODO: Adjust these coordinates based on your gun.gltf model's shape
    // You might need to experiment in-game to get this right.
    return {
      position: { x: 0.03, y: 0.1, z: -0.5 }, // Example position (relative to gun origin)
      rotation: Quaternion.fromEuler(0, 90, 0), // Example rotation
    };
  }
} 