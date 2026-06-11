import * as THREE from 'three';
import { DestructibleMesh, FractureOptions } from '@dgreenheck/three-pinata';
import {
  createEggShellGeometry,
  createShellInnerMaterial,
  createShellMaterial,
  eggSurfacePoint,
} from './egg';

/**
 * Peelable shell. The shell is fractured into Voronoi cells once at build
 * time but rendered assembled, so it looks intact. Cracks live on the
 * boundaries between adjacent cells: each click cracks the boundaries near
 * the impact and connects them to the existing crack network; a piece whose
 * boundaries are all cracked pops loose and can be dragged off.
 */

const FRAGMENT_COUNT = 40;
const SHELL_THICKNESS = 0.015;
/** Grid size used to match shared vertices across fragment meshes. */
const WELD_TOLERANCE = 1e-3;
/** Boundaries whose midpoint is this close to a click crack immediately. */
const CRACK_RADIUS = 0.3;
/** Max boundaries cracked per click, excluding the connecting path. */
const CRACKS_PER_CLICK = 3;
/** Max total length of the path connecting a new crack to the network. */
const CONNECT_MAX_LENGTH = 2.5;
/** How far a loose piece pops outward to show it is free. */
const LOOSE_POP = 0.03;

export interface Boundary {
  pieces: [Piece, Piece];
  /** Crack polyline as flat segment-pair coordinates, in shell space. */
  positions: number[];
  midpoint: THREE.Vector3;
  length: number;
  /** Junction keys where this boundary chain ends and meets others. */
  nodes: string[];
  cracked: boolean;
  line?: THREE.LineSegments;
}

export interface Piece {
  mesh: DestructibleMesh;
  boundaries: Boundary[];
  loose: boolean;
  removed: boolean;
}

export interface Shell {
  group: THREE.Group;
  pieces: Piece[];
  boundaries: Boundary[];
}

function quantize(v: THREE.Vector3): string {
  return (
    Math.round(v.x / WELD_TOLERANCE) +
    ',' +
    Math.round(v.y / WELD_TOLERANCE) +
    ',' +
    Math.round(v.z / WELD_TOLERANCE)
  );
}

interface RawEdge {
  a: THREE.Vector3;
  b: THREE.Vector3;
  key: string;
}

/** Max distance for an outline edge to count as lying on another piece's outline. */
const OUTLINE_MATCH_TOLERANCE = 2e-3;

const segDir = new THREE.Vector3();
const segToPoint = new THREE.Vector3();

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  segDir.subVectors(b, a);
  segToPoint.subVectors(p, a);
  const t = THREE.MathUtils.clamp(
    segToPoint.dot(segDir) / segDir.lengthSq(),
    0,
    1,
  );
  return segToPoint.sub(segDir.multiplyScalar(t)).length();
}

/**
 * Edges of a piece's original-surface triangles (material group 0) that are
 * used by exactly one such triangle: the outline of the piece's patch of the
 * shell surface, which is exactly where a crack against a neighbor shows.
 * Coordinates are lifted into shell space (the fragment geometries are
 * recentered on their own origins).
 */
function surfaceOutlineEdges(mesh: DestructibleMesh): RawEdge[] {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const counts = new Map<string, RawEdge & { uses: number }>();
  const corners: THREE.Vector3[] = [];

  for (const group of geometry.groups) {
    if (group.materialIndex !== 0) continue;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        corners[k] = new THREE.Vector3()
          .fromBufferAttribute(position, vi)
          .add(mesh.position);
      }
      for (let k = 0; k < 3; k++) {
        const a = corners[k];
        const b = corners[(k + 1) % 3];
        const ka = quantize(a);
        const kb = quantize(b);
        if (ka === kb) continue;
        const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        const entry = counts.get(key);
        if (entry) entry.uses++;
        else counts.set(key, { a: a.clone(), b: b.clone(), key, uses: 1 });
      }
    }
  }
  return [...counts.values()].filter((edge) => edge.uses === 1);
}

/**
 * Voronoi seeds on the shell's mid-surface via best-candidate sampling
 * with spatially varying density. Cell size follows seed spacing: purely
 * random seeds produce ungrabbable slivers, but perfectly even spacing
 * looks like artificial honeycomb. So a few random hotspots get tightly
 * packed seeds (small chips) grading out to wide spacing (large plates),
 * with the spacing floor keeping every piece big enough to grab.
 */
function voronoiSeeds(count: number): THREE.Vector3[] {
  const midScale = 1 - SHELL_THICKNESS / 2;
  const randomSurfacePoint = () =>
    eggSurfacePoint(
      // acos maps uniform u to roughly area-uniform latitude (sphere-like).
      Math.acos(1 - 2 * Math.random()) / Math.PI,
      Math.random() * Math.PI * 2,
      midScale,
    );

  const hotspots = Array.from(
    { length: 2 + Math.round(Math.random()) },
    randomSurfacePoint,
  );
  const spacingWeight = (p: THREE.Vector3): number => {
    let nearest = Infinity;
    for (const h of hotspots) nearest = Math.min(nearest, p.distanceTo(h));
    return THREE.MathUtils.lerp(0.5, 1.6, Math.min(nearest / 1.2, 1));
  };

  const seeds: THREE.Vector3[] = [randomSurfacePoint()];
  while (seeds.length < count) {
    let best: THREE.Vector3 | undefined;
    let bestScore = -1;
    for (let c = 0; c < 24; c++) {
      const candidate = randomSurfacePoint();
      let nearest = Infinity;
      for (const seed of seeds) {
        nearest = Math.min(nearest, seed.distanceTo(candidate));
      }
      // Normalizing by the local target spacing lets seeds crowd near
      // hotspots while staying sparse elsewhere.
      const score = nearest / spacingWeight(candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    seeds.push(best!);
  }
  return seeds;
}

export function buildShell(): Shell {
  const source = new DestructibleMesh(
    createEggShellGeometry(1, SHELL_THICKNESS),
    createShellMaterial(),
    createShellInnerMaterial(),
  );
  const fragments = source.fracture(
    new FractureOptions({
      fractureMethod: 'voronoi',
      fragmentCount: FRAGMENT_COUNT,
      voronoiOptions: { mode: '3D', seedPoints: voronoiSeeds(FRAGMENT_COUNT) },
    }),
  );
  source.geometry.dispose();

  const group = new THREE.Group();
  const pieces: Piece[] = fragments.map((mesh) => {
    group.add(mesh);
    return { mesh, boundaries: [], loose: false, removed: false };
  });
  const outlines = pieces.map((piece) => surfaceOutlineEdges(piece.mesh));

  const byPair = new Map<string, { pair: [Piece, Piece]; edges: RawEdge[] }>();
  const addToPair = (i: number, j: number, edge: RawEdge) => {
    const pairKey = Math.min(i, j) + ':' + Math.max(i, j);
    let entry = byPair.get(pairKey);
    if (!entry) {
      entry = { pair: [pieces[i], pieces[j]], edges: [] };
      byPair.set(pairKey, entry);
    }
    entry.edges.push(edge);
  };

  // An outline edge present in exactly two pieces lies on the boundary
  // between them.
  const byKey = new Map<string, { edge: RawEdge; ownerIdx: number[] }>();
  for (let i = 0; i < pieces.length; i++) {
    for (const edge of outlines[i]) {
      const entry = byKey.get(edge.key);
      if (entry) entry.ownerIdx.push(i);
      else byKey.set(edge.key, { edge, ownerIdx: [i] });
    }
  }
  // The two sides of a cut are triangulated independently, so part of a
  // boundary is often subdivided differently on each side (T-junctions) and
  // those edges have no exact twin. Assign them to the piece whose outline
  // passes closest, and keep both sides' edges: each side's run is
  // contiguous, so their union leaves no gaps in the crack line.
  const orphanEdges: { ownerIdx: number; edge: RawEdge }[] = [];
  for (const { edge, ownerIdx } of byKey.values()) {
    if (ownerIdx.length === 2) addToPair(ownerIdx[0], ownerIdx[1], edge);
    else if (ownerIdx.length === 1) orphanEdges.push({ ownerIdx: ownerIdx[0], edge });
  }
  const mid = new THREE.Vector3();
  for (const { ownerIdx, edge } of orphanEdges) {
    mid.addVectors(edge.a, edge.b).multiplyScalar(0.5);
    let bestPiece = -1;
    let bestDist = OUTLINE_MATCH_TOLERANCE;
    for (let j = 0; j < pieces.length; j++) {
      if (j === ownerIdx) continue;
      for (const other of outlines[j]) {
        const d = distanceToSegment(mid, other.a, other.b);
        if (d < bestDist) {
          bestDist = d;
          bestPiece = j;
        }
      }
    }
    if (bestPiece >= 0) addToPair(ownerIdx, bestPiece, edge);
  }

  const boundaries: Boundary[] = [];
  for (const { pair, edges } of byPair.values()) {
    const positions: number[] = [];
    const midpoint = new THREE.Vector3();
    let length = 0;
    const endpointUses = new Map<string, number>();
    for (const edge of edges) {
      positions.push(edge.a.x, edge.a.y, edge.a.z, edge.b.x, edge.b.y, edge.b.z);
      midpoint.add(edge.a).add(edge.b);
      length += edge.a.distanceTo(edge.b);
      for (const k of [quantize(edge.a), quantize(edge.b)]) {
        endpointUses.set(k, (endpointUses.get(k) ?? 0) + 1);
      }
    }
    midpoint.divideScalar(edges.length * 2);
    const nodes = [...endpointUses]
      .filter(([, uses]) => uses === 1)
      .map(([k]) => k);
    const boundary: Boundary = {
      pieces: pair,
      positions,
      midpoint,
      length,
      nodes,
      cracked: false,
    };
    boundaries.push(boundary);
    pair[0].boundaries.push(boundary);
    pair[1].boundaries.push(boundary);
  }

  // The Voronoi fracture occasionally yields a sliver with no patch of the
  // shell surface at all (formed entirely inside the wall thickness). It has
  // no boundaries to crack, so it could never come loose — it is loose by
  // definition, hidden until its neighbors are peeled away.
  for (const piece of pieces) {
    if (piece.boundaries.length === 0) piece.loose = true;
  }

  return { group, pieces, boundaries };
}

const crackMaterial = new THREE.LineBasicMaterial({ color: 0x4a3a2c });

function crackBoundary(shell: Shell, boundary: Boundary): void {
  boundary.cracked = true;
  // Push the line slightly off the surface to avoid z-fighting. Inner-wall
  // segments end up buried inside the wall, which conveniently hides them.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(boundary.positions.map((v) => v * 1.004), 3),
  );
  boundary.line = new THREE.LineSegments(geometry, crackMaterial);
  shell.group.add(boundary.line);
}

/**
 * Crack the shell around a click point: boundaries near the impact crack
 * (always at least one, so every click makes progress), then the new crack
 * is connected to the existing crack network along the cheapest path of
 * boundaries, so cracks visibly grow together instead of staying islands.
 */
export function crackShellAt(shell: Shell, point: THREE.Vector3): void {
  const candidates = shell.boundaries.filter(
    (b) => !b.cracked && !b.pieces[0].removed && !b.pieces[1].removed,
  );
  if (candidates.length === 0) return;
  candidates.sort(
    (p, q) => p.midpoint.distanceTo(point) - q.midpoint.distanceTo(point),
  );

  const hadNetwork = shell.boundaries.some((b) => b.cracked);
  const within = candidates.filter(
    (b) => b.midpoint.distanceTo(point) <= CRACK_RADIUS,
  );
  const newly = (within.length > 0 ? within : candidates.slice(0, 1)).slice(
    0,
    CRACKS_PER_CLICK,
  );
  for (const boundary of newly) crackBoundary(shell, boundary);
  if (hadNetwork) connectToNetwork(shell, newly);
  updateLoosePieces(shell);
}

/** Dijkstra over boundary junctions from the new cracks to the old network. */
function connectToNetwork(shell: Shell, newly: Boundary[]): void {
  const newlySet = new Set(newly);
  const targets = new Set<string>();
  for (const b of shell.boundaries) {
    if (b.cracked && !newlySet.has(b)) for (const n of b.nodes) targets.add(n);
  }
  if (targets.size === 0) return;
  const starts = new Set<string>();
  for (const b of newly) for (const n of b.nodes) starts.add(n);
  for (const n of starts) if (targets.has(n)) return; // already touching

  const incident = new Map<string, Boundary[]>();
  for (const b of shell.boundaries) {
    if (b.pieces[0].removed || b.pieces[1].removed) continue;
    for (const n of b.nodes) {
      const list = incident.get(n);
      if (list) list.push(b);
      else incident.set(n, [b]);
    }
  }

  const dist = new Map<string, number>();
  const via = new Map<string, { from: string; boundary: Boundary }>();
  const queue: [string, number][] = [];
  for (const n of starts) {
    dist.set(n, 0);
    queue.push([n, 0]);
  }
  let goal: string | null = null;
  while (queue.length > 0) {
    queue.sort((a, b) => b[1] - a[1]);
    const [node, d] = queue.pop()!;
    if (d > (dist.get(node) ?? Infinity)) continue;
    if (targets.has(node)) {
      goal = node;
      break;
    }
    if (d > CONNECT_MAX_LENGTH) break;
    for (const boundary of incident.get(node) ?? []) {
      const cost = boundary.cracked ? 0 : boundary.length;
      for (const next of boundary.nodes) {
        if (next === node) continue;
        const nd = d + cost;
        if (nd < (dist.get(next) ?? Infinity)) {
          dist.set(next, nd);
          via.set(next, { from: node, boundary });
          queue.push([next, nd]);
        }
      }
    }
  }
  if (!goal) return;

  let node = goal;
  while (!starts.has(node)) {
    const step = via.get(node)!;
    if (!step.boundary.cracked) crackBoundary(shell, step.boundary);
    node = step.from;
  }
}

function updateLoosePieces(shell: Shell): void {
  for (const piece of shell.pieces) {
    if (piece.loose || piece.removed) continue;
    if (piece.boundaries.length === 0) continue;
    if (!piece.boundaries.every((b) => b.cracked)) continue;
    piece.loose = true;
    // Pop outward so the player can see the piece is free to grab.
    piece.mesh.position.add(
      piece.mesh.position.clone().normalize().multiplyScalar(LOOSE_POP),
    );
  }
}

/**
 * Take a piece out of the shell bookkeeping once it has been peeled off.
 * Crack lines along its boundaries vanish — the open hole shows instead.
 * The mesh itself stays in the scene graph; physics owns it from here.
 */
export function removePiece(piece: Piece): void {
  piece.removed = true;
  for (const boundary of piece.boundaries) {
    if (boundary.line) {
      boundary.line.removeFromParent();
      boundary.line.geometry.dispose();
      boundary.line = undefined;
    }
  }
}
