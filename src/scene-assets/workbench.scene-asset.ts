import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial,
  PlaneGeometry, TorusGeometry,
} from '@iwsdk/core';

const ink = new MeshBasicMaterial({ color: '#171b35' });
const frame = new MeshBasicMaterial({ color: '#292e50' });
const tick = new MeshBasicMaterial({ color: '#8f93ad' });
const orange = new MeshBasicMaterial({ color: '#f5a15e' });
const paper = new MeshBasicMaterial({ color: '#f4ebd9' });

// Manufactured optical frame: origin at the viewport centers, front +Z, up +Y.
// Envelope 0.64 x 0.245 x 0.025 m; the two windows share identical projection.
export const workbench = new Group();
workbench.name = 'Orbit optical frame';
const casing = new Mesh(new BoxGeometry(0.64, 0.245, 0.024), frame);
casing.name = 'Optical frame';
workbench.add(casing);
const windowGeometry = new PlaneGeometry(0.294, 0.207);
for (const [name, x] of [['reference-view', -0.157], ['cut-view', 0.157]] as const) {
  const display = new Mesh(windowGeometry, paper);
  display.name = name;
  display.position.set(x, 0, 0.013);
  workbench.add(display);
  const reticle = new Group();
  reticle.name = `${name}-sight`;
  reticle.position.set(x, 0, 0.0145);
  const horizontal = new Mesh(new BoxGeometry(0.021, 0.0012, 0.0002), ink);
  const vertical = new Mesh(new BoxGeometry(0.0012, 0.021, 0.0002), ink);
  horizontal.name = `${name}-sight-horizontal`;
  vertical.name = `${name}-sight-vertical`;
  reticle.add(horizontal, vertical);
  workbench.add(reticle);
}

// Horizontal yaw wheel: origin is the rotation center, a 0.44 m diameter.
// A broad front paddle is the close-hand and ray target; details share its frame.
export const yawRing = new Group();
yawRing.name = 'Orbit yaw wheel';
const rim = new Mesh(new TorusGeometry(0.206, 0.012, 8, 64), orange);
rim.name = 'Orange calibration rim';
rim.rotation.x = -Math.PI / 2;
yawRing.add(rim);
const plate = new Mesh(new CylinderGeometry(0.192, 0.192, 0.009, 48), ink);
plate.name = 'Yaw wheel face';
plate.position.y = -0.004;
yawRing.add(plate);
const markerGeometry = new BoxGeometry(0.002, 0.002, 0.013);
for (let index = 0; index < 24; index++) {
  const angle = index * Math.PI / 12;
  const marker = new Mesh(markerGeometry, index % 6 === 0 ? paper : tick);
  marker.name = `Yaw tick ${index * 15}`;
  marker.position.set(Math.sin(angle) * 0.178, 0.002, Math.cos(angle) * 0.178);
  marker.rotation.y = angle;
  if (index % 6 === 0) marker.scale.z = 1.7;
  yawRing.add(marker);
}
const paddle = new Mesh(new BoxGeometry(0.073, 0.019, 0.056), orange);
paddle.name = 'Grab paddle';
paddle.position.set(0, 0.007, 0.205);
yawRing.add(paddle);
const pointer = new Mesh(new BoxGeometry(0.005, 0.003, 0.105), orange);
pointer.name = 'Yaw direction pointer';
pointer.position.set(0, 0.004, 0.088);
yawRing.add(pointer);
