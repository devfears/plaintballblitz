import { Quaternion } from 'hytopia';
import MeleeWeaponEntity from '../MeleeWeaponEntity';
import type { MeleeWeaponEntityOptions } from '../MeleeWeaponEntity';
import TerrainDamageManager from '../TerrainDamageManager';
import { GamePlayerEntity } from '../GamePlayerEntity';
import { Vector3Like } from 'hytopia';
import { RaycastHit } from 'hytopia';

const DEFAULT_PICKAXE_OPTIONS: MeleeWeaponEntityOptions = {
  damage: 10,         // 10 hits to kill unshielded
  attackRate: 4.5,    // Slower attack rate to prevent spam
  heldHand: 'right',
  iconImageUri: 'icons/pickaxe.png',
  idleAnimation: 'idle_gun_right',
  mlAnimation: 'simple_interact', 
  name: 'Pickaxe',
  modelUri: 'models/items/pickaxe.gltf',
  modelScale: 1.25,
  range: 2,
  minesMaterials: true,
  attackAudioUri: 'audio/sfx/player/player-swing-woosh.mp3',
  hitAudioUri: 'audio/sfx/dig/dig-stone.mp3',
};

export default class PickaxeEntity extends MeleeWeaponEntity {
  public constructor(options: Partial<MeleeWeaponEntityOptions> = {}) {
    super({ ...DEFAULT_PICKAXE_OPTIONS, ...options, tag: 'pickaxe' });
  }

  public override attack(): void {
    if (!this.parent || !this.processAttack()) return;

    super.attack();
  }

  public override equip(): void {
    super.equip();

    this.setPosition({ x: 0, y: 0.2, z: 0 });
    this.setRotation(Quaternion.fromEuler(-90, 0, 90));
  }

  // Override attackRaycast to instantly break blocks
  protected override attackRaycast(origin: Vector3Like, direction: Vector3Like, length: number): RaycastHit | null | undefined {
    if (!this.parent?.world) return;
   
    const { world } = this.parent;
    const raycastHit = world.simulation.raycast(origin, direction, length, {
      filterExcludeRigidBody: this.parent.rawRigidBody,
    });

    if (raycastHit?.hitBlock) {
      // --- Add check for Y-level --- 
      if (raycastHit.hitBlock.globalCoordinate.y < 0) {
        // Play hit sound but don't break block
        this._hitAudio.play(world, true); 
        console.log('Cannot break blocks at or below Y=-1');
        return raycastHit; // Stop processing if block is too low
      }
      // --- End check ---

      // --- Pickaxe Specific Logic: Instant Break --- 
      const breakPosition = raycastHit.hitBlock.globalCoordinate;
      world.chunkLattice.setBlock(breakPosition, 0); // Instantly set block to air
      // const brokeBlock = true; // No longer needed as we don't check minesMaterials
      // --- End Pickaxe Specific Logic ---

      // --- Remove Material Awarding Logic ---
      // if (this.minesMaterials && brokeBlock) { 
      //   const player = this.parent as GamePlayerEntity;
      //   const blockId = raycastHit.hitBlock.blockType.id;
      //   const materialCount = TerrainDamageManager.getBreakMaterialCount(blockId);
      // 
      //   player.addMaterial(materialCount);
      // } 
      // --- End Remove Material Awarding Logic ---

      // Play hit sound for blocks
      this._hitAudio.play(world, true);
    }

    if (raycastHit?.hitEntity) {
      // Use base class logic for hitting entities
      this._handleHitEntity(raycastHit.hitEntity, direction);
      // Play hit sound for entities
      this._hitAudio.play(world, true); 
    }

    // Note: Hit sound is now played within specific hit blocks/entities logic
    // to avoid playing it twice if both are hit somehow?

    return raycastHit;
  }
}
