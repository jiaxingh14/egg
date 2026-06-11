import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Egg profile revolved around the Y axis. y runs from -1 (blunt end, bottom)
 * to +1 (pointy end, top); the (1 - 0.2y) factor tapers the top and fattens
 * the bottom, and the 0.72 width ratio matches a hen egg's length:width.
 */
function eggProfilePoint(t01: number, scale: number): THREE.Vector2 {
  const t = t01 * Math.PI;
  const y = -Math.cos(t);
  const r = Math.sin(t) * (1 - 0.2 * y) * 0.72;
  return new THREE.Vector2(r * scale, y * scale);
}

/** Point on the egg surface at profile parameter t01 (0=bottom, 1=top) and revolution angle theta. */
export function eggSurfacePoint(t01: number, theta: number, scale = 1): THREE.Vector3 {
  const p = eggProfilePoint(t01, scale);
  return new THREE.Vector3(p.x * Math.cos(theta), p.y, p.x * Math.sin(theta));
}

export function createEggGeometry(scale = 1, radialSegments = 96): THREE.BufferGeometry {
  const profileSegments = 96;
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= profileSegments; i++) {
    points.push(eggProfilePoint(i / profileSegments, scale));
  }
  const geometry = new THREE.LatheGeometry(points, radialSegments);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Hollow thin-walled shell: the outer egg surface plus an inner scaled copy.
 * three-pinata needs a watertight solid to tell inside from outside when
 * fracturing, and a hollow wall makes the fragments read as shell shards
 * rather than solid wedges. Resolution is deliberately lower than the
 * visible white's — fracture cost grows with triangle count.
 */
export function createEggShellGeometry(
  scale = 1,
  thickness = 0.015,
  radialSegments = 48,
): THREE.BufferGeometry {
  const profileSegments = 48;
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= profileSegments; i++) {
    points.push(eggProfilePoint(i / profileSegments, scale));
  }
  for (let i = profileSegments; i >= 0; i--) {
    points.push(eggProfilePoint(i / profileSegments, scale - thickness));
  }
  return weld(new THREE.LatheGeometry(points, radialSegments));
}

/**
 * LatheGeometry duplicates vertices along the wrap seam and emits zero-area
 * triangles where the profile touches the axis; both violate the manifold
 * assumption the fracture algorithm relies on. Weld by position (normals are
 * recomputed, UVs dropped — the shell materials are untextured) and drop
 * degenerate triangles.
 */
function weld(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  const welded = mergeVertices(geometry);
  geometry.dispose();

  const index = welded.getIndex()!;
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (a !== b && b !== c && c !== a) kept.push(a, b, c);
  }
  welded.setIndex(kept);
  welded.computeVertexNormals();
  return welded;
}

export function createShellMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xc9a07b,
    roughness: 0.65,
    metalness: 0,
  });
}

/** Cut faces of shell fragments: the pale membrane lining the shell. */
export function createShellInnerMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xf6f1e6,
    roughness: 0.9,
    metalness: 0,
  });
}

/**
 * Boiled egg white: wet-shiny via clearcoat, with sheen standing in for the
 * soft subsurface look. Tuned against RoomEnvironment lighting in main.ts.
 */
export function createEggWhiteMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xfffaf0,
    roughness: 0.38,
    clearcoat: 1.0,
    clearcoatRoughness: 0.25,
    sheen: 0.6,
    sheenColor: new THREE.Color(0xffffff),
    sheenRoughness: 0.5,
  });
}
