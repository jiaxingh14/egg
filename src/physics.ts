import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

await RAPIER.init();

// Stronger-than-real gravity: the egg is ~2 units tall, and at that scale
// 9.81 reads as floaty slow motion.
export const world = new RAPIER.World({ x: 0, y: -20, z: 0 });

const FIXED_DT = 1 / 60;
const CULL_Y = -8;

interface Tracked {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
}

const tracked: Tracked[] = [];

/** Fixed convex collider matching a static mesh (e.g. the egg white). */
export function addStaticConvexCollider(mesh: THREE.Mesh): void {
  const p = mesh.getWorldPosition(new THREE.Vector3());
  const q = mesh.getWorldQuaternion(new THREE.Quaternion());
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z).setRotation(q),
  );
  const collider = describeConvexHull(mesh.geometry);
  world.createCollider(collider.setFriction(0.5).setRestitution(0.2), body);
}

/**
 * Dynamic body for a shell fragment. The fragment mesh must already be
 * positioned in world space with its geometry centered on its origin
 * (which is how three-pinata hands fragments back).
 */
export function addFragmentBody(
  mesh: THREE.Mesh,
  linvel: THREE.Vector3,
  angvel: THREE.Vector3,
): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
      .setRotation(mesh.quaternion)
      .setLinvel(linvel.x, linvel.y, linvel.z)
      .setAngvel(angvel),
  );
  world.createCollider(
    describeConvexHull(mesh.geometry).setFriction(0.6).setRestitution(0.3),
    body,
  );
  tracked.push({ mesh, body });
}

function describeConvexHull(geometry: THREE.BufferGeometry): RAPIER.ColliderDesc {
  const positions = geometry.getAttribute('position').array as Float32Array;
  const hull = RAPIER.ColliderDesc.convexHull(positions);
  if (hull) return hull;
  // Sliver fragments can defeat the hull builder; approximate with a ball.
  geometry.computeBoundingSphere();
  return RAPIER.ColliderDesc.ball(Math.max(geometry.boundingSphere!.radius * 0.5, 0.01));
}

let accumulator = 0;

/**
 * Advance the simulation in fixed steps and copy body transforms onto their
 * meshes. Fragments that fall below CULL_Y are removed from both worlds.
 */
export function stepPhysics(delta: number): void {
  accumulator = Math.min(accumulator + delta, 0.25);
  while (accumulator >= FIXED_DT) {
    world.step();
    accumulator -= FIXED_DT;
  }
  for (let i = tracked.length - 1; i >= 0; i--) {
    const { mesh, body } = tracked[i];
    const t = body.translation();
    if (t.y < CULL_Y) {
      world.removeRigidBody(body);
      mesh.removeFromParent();
      mesh.geometry.dispose();
      tracked.splice(i, 1);
      continue;
    }
    mesh.position.set(t.x, t.y, t.z);
    const r = body.rotation();
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
