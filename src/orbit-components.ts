import { createComponent, Types } from '@iwsdk/core';

export const OrbitCutState = createComponent('OrbitCutState', {
  yawDegrees: { type: Types.Float32, default: 0, label: 'After image yaw (degrees)' },
  activeShot: { type: Types.String, default: 'after' },
  isDragging: { type: Types.Boolean, default: false },
  inputKind: { type: Types.String, default: 'none' },
  sourceOffsetDegrees: { type: Types.Float32, default: 55 },
  residualDegrees: { type: Types.Float32, default: 55 },
  aligned: { type: Types.Boolean, default: false },
  grabCount: { type: Types.Int32, default: 0 },
  cutCount: { type: Types.Int32, default: 0 },
  mediaReady: { type: Types.Boolean, default: false },
  previewYawDegrees: { type: Types.Float32, default: 0 },
});

export const YawRing = createComponent('YawRing', {});
export const WorkbenchPart = createComponent('WorkbenchPart', {});
