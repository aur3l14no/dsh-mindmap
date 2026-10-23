# Third-party notices

`client.canvas.js` bundles Excalidraw; `assets/` and the Host renderer use the
packages and fonts below. Each remains under its own license.

| Component | Version | License | Use |
| --- | --- | --- | --- |
| [@excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) and the dependencies bundled in its distribution | 0.18.1 | MIT | Canvas editor in `client.canvas.js` |
| [roughjs](https://github.com/rough-stuff/rough) | 4.6.4 | MIT | Hand-drawn shapes in Host-rendered images |
| [perfect-freehand](https://github.com/steveruizok/perfect-freehand) | 1.2.0 | MIT | Freehand strokes in Host-rendered images |
| [@resvg/resvg-js](https://github.com/yisibl/resvg-js) | 2.6.2 | MPL-2.0 | SVG to PNG rasterization on the Host |
| [fractional-indexing](https://github.com/rocicorp/fractional-indexing) | 3.2.0 | CC0-1.0 | Element order keys |

Fonts shipped by Excalidraw, served from `assets/excalidraw/fonts/` and merged
into `assets/fonts/*.otf` for Host rendering:

| Font | License |
| --- | --- |
| Excalifont, Virgil | SIL Open Font License 1.1 |
| Nunito, Lilita One, Assistant | SIL Open Font License 1.1 |
| Cascadia Code | SIL Open Font License 1.1 |
| Comic Shanns | MIT |
| Liberation Sans | SIL Open Font License 1.1 |
| Xiaolai (derived from Klee One) | SIL Open Font License 1.1 |

The merged `.otf` files only recombine the published subsets of each family
under its original name, as the licenses permit.
