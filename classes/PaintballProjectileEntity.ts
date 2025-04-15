import {
  Entity,
  EntityEvent,
  EntityOptions,
  RigidBodyType,
  ColliderShape,
  Vector3,
  Vector3Like,
  BlockType,
  World,
  Quaternion,
  // Import specific payload types directly
  type EntityCollisionPayload,
  type BlockCollisionPayload,
  CollisionGroup
} from 'hytopia';
import GamePlayerEntity from './GamePlayerEntity'; // Assuming GamePlayerEntity is in the same directory

// --- Damage Drop-off Constants (copied from GunEntity) ---
const FULL_DAMAGE_RANGE = 15; // Max distance (meters) for full damage
const MIN_DAMAGE_RANGE = 40;  // Distance beyond which minimum damage is applied
const MIN_DAMAGE_MULTIPLIER = 0.2; // Minimum damage multiplier (20%)
// --- End Damage Drop-off Constants ---

const PROJECTILE_SPEED = 50; // Adjust as needed (meters per second)
const PROJECTILE_LIFETIME_MS = 3000; // Projectile self-destructs after 3 seconds if it hits nothing

// Interface for options specific to our projectile
interface PaintballProjectileEntityOptions extends Partial<EntityOptions> {
  shooter: GamePlayerEntity;
  initialDamage: number;
  // Remove initialVelocity as it's set via initiate()
}

// // Define a type for the collision event payload we expect
// // This helps ensure we get the collider handles if available
// type CollisionPayload = EventPayloads[EntityEvent.ENTITY_COLLISION] | EventPayloads[EntityEvent.BLOCK_COLLISION];
// No longer needed, use specific payload types

export default class PaintballProjectileEntity extends Entity {
  private shooter: GamePlayerEntity;
  private initialDamage: number;
  private lifeTimeout: NodeJS.Timeout | undefined;

  constructor(options: PaintballProjectileEntityOptions) {
    const projectileOptions: EntityOptions = {
      // Use the paintblock model for the projectile
      modelUri: 'models/environment/paintblock.gltf',
      modelScale: 0.2, // Adjust scale as needed
      // Make it a DYNAMIC rigid body so gravity affects it
      rigidBodyOptions: {
        type: RigidBodyType.DYNAMIC,
        ccdEnabled: true, // Enable Continuous Collision Detection
        additionalMass: 0.1, // Give it a small mass
        linearDamping: 0.05, // Slight air resistance
        angularDamping: 0.1,
        gravityScale: 1.0, // Ensure gravity affects it
        colliders: [
          {
            shape: ColliderShape.BALL,
            radius: 0.1,
            isSensor: false, // Make it a solid collider to hit things
            // Explicitly define collision groups
            collisionGroups: {
              belongsTo: [ CollisionGroup.ENTITY ], // Belongs to entity group
              collidesWith: [ CollisionGroup.BLOCK, CollisionGroup.ENTITY ] // Should collide with Blocks and other Entities
            }
          },
        ],
      },
      // Merge any other partial options passed in
      ...options,
    };

    super(projectileOptions);

    this.shooter = options.shooter;
    this.initialDamage = options.initialDamage;

    // Set up specific collision handlers
    this.on(EntityEvent.ENTITY_COLLISION, this._handleEntityCollision);
    this.on(EntityEvent.BLOCK_COLLISION, this._handleBlockCollision);
  }

  /**
   * Spawns the projectile and sets its initial velocity and lifetime.
   */
  public override spawn(world: World, position: Vector3Like, rotation?: Quaternion): void {
    super.spawn(world, position, rotation);

    // Clear any previous lifetime timer
    if (this.lifeTimeout) {
      clearTimeout(this.lifeTimeout);
    }

    // Set timer to automatically despawn after a duration
    this.lifeTimeout = setTimeout(() => {
      if (this.isSpawned) {
        this.despawn();
      }
    }, PROJECTILE_LIFETIME_MS);
  }

  /**
   * Initiates the projectile's movement.
   * Should be called immediately after spawning.
   * @param velocity The initial velocity vector.
   */
  public initiate(velocity: Vector3Like): void {
    if (!this.isSpawned) return;
    this.setLinearVelocity(velocity);
  }

  /**
   * Handles collisions ONLY with other entities.
   */
  private _handleEntityCollision = (payload: EntityCollisionPayload): void => {
    // Log specific, non-cyclic payload properties
    console.log(
      `>>> _handleEntityCollision CALLED. ` +
      `Started: ${payload.started}, ` +
      `Entity A: ${payload.colliderHandleA}, ` +
      `Entity B: ${payload.colliderHandleB}, ` +
      `OtherEntity: ${payload.otherEntity?.id ?? 'N/A'}`
    );

    // Destructure properties from the payload
    const { otherEntity, started } = payload;

    // We only care about the initial impact
    if (!started || !this.isSpawned) {
      console.log(`>>> _handleEntityCollision EXITING EARLY (started: ${started}, isSpawned: ${this.isSpawned})`);
      return;
    }

    let hitEntity: Entity | undefined = undefined;
    let hitDirection: Vector3Like | undefined = undefined;

    // --- Entity Collision Logic ---
    // Ignore collision with the shooter or other projectiles from the same shooter (optional)
    if (otherEntity === this.shooter || otherEntity instanceof PaintballProjectileEntity) {
        console.log(`>>> _handleEntityCollision ignoring collision with shooter or another projectile.`);
       return;
    }
    hitEntity = otherEntity;
    // Calculate hit direction (vector from hit entity to projectile)
    const projectilePosVec3 = Vector3.fromVector3Like(this.position);
    const hitEntityPosVec3 = Vector3.fromVector3Like(hitEntity.position);
    hitDirection = projectilePosVec3.subtract(hitEntityPosVec3).normalize();

    // --- Calculate Damage Drop-off ---
    const shooterPosVec3 = Vector3.fromVector3Like(this.shooter.position);
    const impactPosVec3 = Vector3.fromVector3Like(this.position);
    // Manual distance calculation
    const dx = shooterPosVec3.x - impactPosVec3.x;
    const dy = shooterPosVec3.y - impactPosVec3.y;
    const dz = shooterPosVec3.z - impactPosVec3.z;
    const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
    let damageMultiplier = 1.0;

    if (distance > FULL_DAMAGE_RANGE) {
      if (distance >= MIN_DAMAGE_RANGE) {
        damageMultiplier = MIN_DAMAGE_MULTIPLIER;
      } else {
        // Linear drop-off between full and min range
        const rangeSpan = MIN_DAMAGE_RANGE - FULL_DAMAGE_RANGE;
        const distanceIntoDropoff = distance - FULL_DAMAGE_RANGE;
        damageMultiplier = 1.0 - (distanceIntoDropoff / rangeSpan) * (1.0 - MIN_DAMAGE_MULTIPLIER);
      }
    }
    const finalDamage = Math.round(this.initialDamage * damageMultiplier);
    // --- End Calculate Damage Drop-off ---

    // Apply damage if we hit a valid player entity and damage is > 0
    if (hitEntity instanceof GamePlayerEntity && !hitEntity.isDead && finalDamage > 0) {
        console.log(`Projectile attempting to deal ${finalDamage} damage to ${hitEntity.name}`);
        this.shooter.dealtDamage(finalDamage); // Notify shooter
        hitEntity.takeDamage(finalDamage, hitDirection || { x: 0, y: 0, z: -1 }, this.shooter);
    }
    // --- End Entity Collision Logic ---

    // Despawn the projectile on *any* collision it handles
    console.log(`>>> Despawning projectile after ENTITY collision.`);
    this.despawn();
  }

  /**
   * Handles collisions ONLY with blocks.
   * Includes splatter effect.
   */
  private _handleBlockCollision = (payload: BlockCollisionPayload): void => {
     // Log specific, non-cyclic payload properties
     console.log(
      `>>> _handleBlockCollision CALLED. ` +
      `Started: ${payload.started}, ` +
      `Entity Handle: ${payload.colliderHandleA}, ` + // Assuming A is the entity
      `Block Handle: ${payload.colliderHandleB}, ` + // Assuming B is the block
      `BlockType: ${payload.blockType?.name ?? 'N/A'}`
    );

    // Destructure properties from the payload
    const { started, blockType, colliderHandleA, colliderHandleB } = payload;

    // We only care about the initial impact
    if (!started || !this.isSpawned) {
      console.log(`>>> _handleBlockCollision EXITING EARLY (started: ${started}, isSpawned: ${this.isSpawned})`);
      return;
    }

    console.log(`>>> Entered BLOCK COLLISION logic.`); // Simple log to confirm entry

    // --- Splatter Effect Logic ---
    if (this.world && colliderHandleA !== undefined && colliderHandleB !== undefined) {
      console.log(`>>> Attempting to get contact manifolds (Entity Handle: ${colliderHandleA}, Block Handle: ${colliderHandleB})`);
      // Get contact manifold info from the physics simulation
      const contactManifolds = this.world.simulation.getContactManifolds(colliderHandleA, colliderHandleB);
      // Ensure we have a manifold and contact point
      if (contactManifolds && contactManifolds.length > 0 && contactManifolds[0].contactPoints.length > 0) {
        const manifold = contactManifolds[0];
        const contactPoint = manifold.contactPoints[0];
        // Attempt to get the collision normal (direction the surface is facing)
        // Note: The exact property name for the normal might differ, common names are .normal, .worldNormalOnB
        // We'll assume 'normal' for now, adjust if needed based on SDK specifics or errors.
        const contactNormal = Vector3.fromVector3Like(manifold.normal || { x: 0, y: 1, z: 0 });

        if (contactPoint) {
          // Removed setTimeout to spawn synchronously
          console.log(`Projectile hit block at contact point: ${JSON.stringify(contactPoint)}`);
          console.log(`Collision normal: ${JSON.stringify(contactNormal)}`);

          // --- Calculate Offset Position ---
          const offsetDistance = 0.02; // Reset to small offset distance
          // Manual scaling for offset vector
          const offsetVector: Vector3Like = {
            x: contactNormal.x * offsetDistance,
            y: contactNormal.y * offsetDistance,
            z: contactNormal.z * offsetDistance
          };
          const spawnPosition = Vector3.fromVector3Like(contactPoint).add(Vector3.fromVector3Like(offsetVector));
          // --- End Calculate Offset Position ---

          // --- Calculate Rotation ---
          // Much simpler direct approach based on exact normal values
          let rotation;

          // Extract the normal components for easier reference
          const nx = contactNormal.x || contactNormal[0] || 0;
          const ny = contactNormal.y || contactNormal[1] || 0;
          const nz = contactNormal.z || contactNormal[2] || 0;

          // Log the exact normal values for debugging
          console.log(`Exact normal values: nx=${nx}, ny=${ny}, nz=${nz}`);

          // Random angles for variety
          const randomYaw = Math.random() * 360; // Random rotation around Y axis
          const randomRoll = Math.random() * 360; // Random rotation around Z axis
          const randomPitch = Math.random() * 360; // Random rotation around X axis

          // Check for exact normal cases and apply precise rotations with randomization
          if (ny === 1) {
            // Floor - flat on ground with random rotation around normal
            rotation = Quaternion.fromEuler(0, randomYaw, 0);
            console.log(`Floor case detected: Using rotation with random yaw=${randomYaw}`);
          } 
          else if (ny === -1) {
            // Ceiling - flat but upside down with random rotation around normal
            rotation = Quaternion.fromEuler(180, randomYaw, 0);
            console.log(`Ceiling case detected: Using rotation with pitch=180, random yaw=${randomYaw}`);
          } 
          else if (nx === 1) {
            // Wall facing positive X - needs to be flat against wall
            rotation = Quaternion.fromEuler(randomPitch, 0, 90);
            console.log(`Wall +X case detected: Using rotation with random pitch=${randomPitch}, roll=90`);
          } 
          else if (nx === -1) {
            // Wall facing negative X - needs to be flat against wall
            rotation = Quaternion.fromEuler(randomPitch, 0, -90);
            console.log(`Wall -X case detected: Using rotation with random pitch=${randomPitch}, roll=-90`);
          } 
          else if (nz === 1) {
            // Wall facing positive Z - needs to be flat against wall
            rotation = Quaternion.fromEuler(90, 0, randomRoll);
            console.log(`Wall +Z case detected: Using rotation with pitch=90, random roll=${randomRoll}`);
          } 
          else if (nz === -1) {
            // Wall facing negative Z - needs to be flat against wall
            rotation = Quaternion.fromEuler(-90, 0, randomRoll);
            console.log(`Wall -Z case detected: Using rotation with pitch=-90, random roll=${randomRoll}`);
          } 
          else {
            // Angled surface - default to a conservative approach
            if (Math.abs(ny) > 0.8) {
              // Mostly floor/ceiling
              rotation = Quaternion.fromEuler(ny > 0 ? 0 : 180, randomYaw, randomRoll);
              console.log(`Near-floor/ceiling case: Using rotation with pitch=${ny > 0 ? 0 : 180}, random yaw=${randomYaw}, random roll=${randomRoll}`);
            }
            else if (Math.abs(nx) > 0.8) {
              // Mostly X-axis wall
              rotation = Quaternion.fromEuler(randomPitch, 0, nx > 0 ? 90 : -90);
              console.log(`Near X-wall case: Using rotation with random pitch=${randomPitch}, roll=${nx > 0 ? 90 : -90}`);
            }
            else if (Math.abs(nz) > 0.8) {
              // Mostly Z-axis wall
              rotation = Quaternion.fromEuler(nz > 0 ? 90 : -90, randomPitch, randomRoll);
              console.log(`Near Z-wall case: Using rotation with pitch=${nz > 0 ? 90 : -90}, random pitch=${randomPitch}, random roll=${randomRoll}`);
            }
            else {
              // Truly angled surface - use random rotation
              rotation = Quaternion.fromEuler(randomPitch, randomYaw, randomRoll);
              console.log(`Angled surface case: Using fully random rotation`);
            }
          }
          // --- End Calculate Rotation ---

          // Create a splatter entity using the custom model
          const splatter = new Entity({
            modelUri: 'models/environment/paintsplatter.gltf',
            modelScale: 0.5, // Increased scale
            rigidBodyOptions: {
              type: RigidBodyType.KINEMATIC_POSITION,
            }
          });

          console.log(`>>> Spawning splatter MODEL at ${JSON.stringify(spawnPosition)} WITH rotation ${JSON.stringify(rotation)}`);
          splatter.spawn(this.world, spawnPosition, rotation);
          console.log(`>>> Splatter entity SPAWNED successfully.`);

          splatter.setCollisionGroupsForSolidColliders({
            belongsTo: [],
            collidesWith: [],
          });

          const SPLATTER_LIFETIME_MS = 10000;
          setTimeout(() => {
            if (splatter.isSpawned) {
              splatter.despawn();
            }
          }, SPLATTER_LIFETIME_MS);
        } else {
          console.log('PaintballProjectile: Could not get contact point from manifold.');
        }
      } else {
        console.log('PaintballProjectile: Could not get contact manifold or contact points.');
      }
    } else {
      console.log(`PaintballProjectile: Could not attempt splatter: Missing world (${!!this.world}) or collider handles (A=${colliderHandleA}, B=${colliderHandleB}).`);
    }
    // --- End Splatter Effect Logic ---

    // **Block is NOT broken**
    // // Set the block to air
    // this.world.chunkLattice.setBlock(blockCoords, 0);

    // Despawn the projectile on *any* collision it handles
    console.log(`>>> Despawning projectile after BLOCK collision.`);
    this.despawn();
  }

  /**
   * Clean up timer on despawn.
   */
  public override despawn(): void {
    if (this.lifeTimeout) {
      clearTimeout(this.lifeTimeout);
      this.lifeTimeout = undefined;
    }
    super.despawn();
  }
} 