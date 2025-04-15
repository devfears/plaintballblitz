import {
  PlayerEvent,
  startServer,
  WorldEvent,
} from 'hytopia';

import GameManager from './classes/GameManager';

import worldMap from './assets/terrain (6).json';

startServer(world => {
  // Load the game map
  world.loadMap(worldMap);

  // Disable debug raycasting
  world.simulation.enableDebugRaycasting(false);

  // Set lighting
  world.setAmbientLightIntensity(0.8);
  world.setDirectionalLightIntensity(5);

  // Initialize the GameManager
  GameManager.instance.setupGame(world);

  // Handle player joining the game
  world.on(PlayerEvent.JOINED_WORLD, ({ player }) => {
    GameManager.instance.handlePlayerJoined(player);
  });

  // Handle player leaving the game
  world.on(PlayerEvent.LEFT_WORLD, ({ player }) => {
    // Clean up player entities
    world.entityManager
      .getPlayerEntitiesByPlayer(player)
      .forEach(entity => entity.despawn());

    GameManager.instance.playerCount--;
  });
});


/*
- raycasts from weapons need to ignore other items
- Fix players stuck in placed blocks
*/