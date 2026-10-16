import { AssetType, defineAssets } from '@iwsdk/core';
import { panorama, workbench, yawRing } from './scene-assets/workbench.scene-asset.js';

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

export default defineAssets({
  'optical-frame': workbench,
  'yaw-wheel': yawRing,
  'panorama-screen': panorama,
  'workbench-panel': {
    url: url('ui/workbench.uikitml'), type: AssetType.UIKitML, name: 'Orbit Cut controls',
  },
  'shot-before': { url: url('media/shot-before.png'), type: AssetType.Texture },
  'shot-after': { url: url('media/shot-after.png'), type: AssetType.Texture },
});
