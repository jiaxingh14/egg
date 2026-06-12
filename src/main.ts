import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createEggGeometry, createEggWhiteMaterial } from './egg';
import {
  animateLoosePieces,
  buildShell,
  crackShellAt,
  removePiece,
  type Piece,
} from './shell';
import { addFragmentBody, addStaticConvexCollider, stepPhysics } from './physics';
import './style.css';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c1c20);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0.6, 4);

// Key light for a strong specular highlight on the egg white; the
// environment map provides the fill.
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(3, 4, 2);
scene.add(keyLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2;
controls.maxDistance = 10;

// Sits just inside the shell's inner wall (1 - thickness 0.015), with a
// clearance well below the shell thickness so peeled shards can't lodge
// themselves in the gap.
const white = new THREE.Mesh(createEggGeometry(0.98), createEggWhiteMaterial());
white.name = 'white';
scene.add(white);

// Shell pieces slide and bounce off the white instead of falling through.
addStaticConvexCollider(white);

const shell = buildShell();
scene.add(shell.group);

// Handles for poking at the scene from the console / automated tests.
Object.assign(window as unknown as Record<string, unknown>, {
  __shell: shell,
  __camera: camera,
  __controls: controls,
});

// --- Cracking and peeling ---------------------------------------------------
// Click (pointer down/up without dragging) on the shell: cracks appear around
// the impact and connect with earlier cracks. Once a piece is fully
// surrounded by cracks it pops loose; loose pieces are dragged off with the
// pointer and handed to physics on release.

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const pointerDownAt = new THREE.Vector2();
const CLICK_TOLERANCE_PX = 5;

function pieceUnderPointer(
  event: PointerEvent,
): { piece: Piece; point: THREE.Vector3 } | null {
  pointerNdc.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, camera);
  // The white is included as an occluder so clicks can't reach shell pieces
  // through the peeled-open egg.
  const meshes: THREE.Object3D[] = shell.pieces
    .filter((p) => !p.removed)
    .map((p) => p.mesh);
  meshes.push(white);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit || hit.object === white) return null;
  const piece = shell.pieces.find((p) => p.mesh === hit.object)!;
  return { piece, point: hit.point };
}

interface Drag {
  piece: Piece;
  plane: THREE.Plane;
  offset: THREE.Vector3;
  velocity: THREE.Vector3;
  lastPoint: THREE.Vector3;
  lastTime: number;
  /** Pieces can only be dragged away from the egg, never into it. */
  minRadius: number;
}
let drag: Drag | null = null;

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDownAt.set(event.clientX, event.clientY);
  const hit = pieceUnderPointer(event);
  if (!hit?.piece.loose) return;

  // Drag the piece on a camera-facing plane through its current position.
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    camera.getWorldDirection(new THREE.Vector3()),
    hit.piece.mesh.position,
  );
  const onPlane = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (!onPlane) return;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
  drag = {
    piece: hit.piece,
    plane,
    offset: hit.piece.mesh.position.clone().sub(onPlane),
    velocity: new THREE.Vector3(),
    lastPoint: hit.piece.mesh.position.clone(),
    lastTime: performance.now(),
    minRadius: hit.piece.mesh.position.length(),
  };
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (drag) {
    pointerNdc.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const onPlane = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!onPlane) return;
    const target = onPlane.add(drag.offset);
    if (target.length() < drag.minRadius) target.setLength(drag.minRadius);
    const now = performance.now();
    const dt = Math.max((now - drag.lastTime) / 1000, 1e-3);
    drag.velocity.lerp(target.clone().sub(drag.lastPoint).divideScalar(dt), 0.35);
    drag.piece.mesh.position.copy(target);
    drag.lastPoint.copy(target);
    drag.lastTime = now;
    return;
  }
  const hit = pieceUnderPointer(event);
  renderer.domElement.style.cursor = hit?.piece.loose ? 'grab' : 'default';
});

function randomSpin(strength: number): THREE.Vector3 {
  return new THREE.Vector3(
    Math.random() - 0.5,
    Math.random() - 0.5,
    Math.random() - 0.5,
  ).multiplyScalar(strength);
}

/**
 * Hand a piece over to physics. Pieces this leaves with no neighbors at
 * all have nothing holding them, so they tumble off on their own.
 */
function releasePiece(piece: Piece, velocity: THREE.Vector3, spin: THREE.Vector3): void {
  const isolated = removePiece(piece);
  addFragmentBody(piece.mesh, velocity, spin);
  for (const neighbor of isolated) {
    const away = neighbor.mesh.position.clone().normalize().multiplyScalar(0.4);
    releasePiece(neighbor, away, randomSpin(2));
  }
}

renderer.domElement.addEventListener('pointerup', (event) => {
  if (drag) {
    const { piece, velocity } = drag;
    drag = null;
    controls.enabled = true;
    releasePiece(piece, velocity.clampLength(0, 6), randomSpin(4));
    return;
  }

  const moved = pointerDownAt.distanceTo(
    new THREE.Vector2(event.clientX, event.clientY),
  );
  if (moved > CLICK_TOLERANCE_PX) return; // it was a rotate-drag, not a click
  const hit = pieceUnderPointer(event);
  if (hit && !hit.piece.loose) crackShellAt(shell, hit.point);
});

// --------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  stepPhysics(clock.getDelta());
  animateLoosePieces(shell, clock.elapsedTime, drag?.piece);
  controls.update();
  renderer.render(scene, camera);
});
