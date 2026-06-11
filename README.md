# egg

An interactive boiled egg. Rotate it, click to crack the shell, peel it down
to a white, shiny, bouncy egg.

## Stack

- [three.js](https://threejs.org/) — rendering, OrbitControls rotation
- [@dgreenheck/three-pinata](https://github.com/dgreenheck/three-pinata) — shell fracturing (planned)
- [@dimforge/rapier3d-compat](https://rapier.rs/) — physics for shell fragments and bounce (planned)
- Vite + TypeScript

## Commands

```sh
npm install
npm run dev      # dev server
npm run build    # type-check + production build
npm run preview  # serve the production build
```
