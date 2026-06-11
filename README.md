# egg

An interactive boiled egg (v0.1). Rotate it, tap it to crack the shell, then
peel the pieces off to reveal the white underneath.

## How to play

- **Drag** — orbit around the egg.
- **Click the shell** — cracks appear around the impact and grow together
  with cracks from earlier clicks.
- **Peel** — a piece that is fully surrounded by cracks pops loose
  (grab cursor); drag it off and let go to flick it away.

## How it works

The shell is fractured into ~40 Voronoi cells once at load time but rendered
assembled, so it looks intact. Cracks live on the precomputed boundaries
between cells:

- **Geometry** — the shell is a hollow, watertight thin-walled lathe
  ([src/egg.ts](src/egg.ts)); three-pinata needs a manifold solid to
  fracture, and the hollow wall makes fragments read as shell shards.
- **Fracture** — Voronoi seeds are placed by variable-density best-candidate
  sampling on the shell mid-surface ([src/shell.ts](src/shell.ts)): tight
  spacing near a few random hotspots, wide elsewhere, so pieces range from
  small chips to large plates with no ungrabbable slivers.
- **Cracking** — each click cracks the cell boundaries near the hit point,
  then connects them to the existing crack network along the cheapest path
  (Dijkstra over boundary junctions). A piece with all boundaries cracked
  comes loose.
- **Physics** — peeled pieces become Rapier rigid bodies with convex-hull
  colliders ([src/physics.ts](src/physics.ts)); they bounce off the white
  and fall away.

## Stack

- [three.js](https://threejs.org/) — rendering, OrbitControls rotation
- [@dgreenheck/three-pinata](https://github.com/dgreenheck/three-pinata) — Voronoi shell fracturing
- [@dimforge/rapier3d-compat](https://rapier.rs/) — physics for peeled shell pieces
- Vite + TypeScript

## Commands

```sh
npm install
npm run dev      # dev server
npm run build    # type-check + production build
npm run preview  # serve the production build
```

## Roadmap

- Bouncy/jiggly peeled egg (spring-damped vertex wobble)
- Plate/ground plane for pieces to land on
