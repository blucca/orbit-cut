import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { OrbitSystem } from './orbit-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions)
  .then(world => world.registerSystem(OrbitSystem))
  .catch(error => {
    document.querySelector<HTMLElement>('#media-message')!.textContent = `Workbench failed to load: ${error.message}. Reload to retry.`;
    console.error(error);
  });
