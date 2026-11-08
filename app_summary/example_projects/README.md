# Example projects

Exports of 7 of the 35 saved projects, chosen to cover the feature range. Each `<name>.json` is the
server record (`name`, `id`, `config`). `config` is exactly what `gatherConfig()` produces and
`applyConfig()` consumes. Link meshes under 1 MB are copied into `meshes/` under the same UUID
filename the config's `meshId` refers to.

| File | Shape | Links | Notable | Mesh |
|---|---|---|---|---|
| `longchain.json` | spiral r=26, spacing 12.5 | 100 | default colour swap every 2nd link; used for the full screenshot walkthrough | 130 KB glb |
| `ultralongversion.json` | spiral r=45, spacing 18 | 244 | long chain, 1.30 m | 71 KB glb |
| `fish.json` | spiral r=58, spacing 16 | 24 | organic segment | 94 KB glb |
| `drag2.json` | spiral r=81, spacing 21 | 35 | dragon body segment | 94 KB glb |
| `shartk2.json` | spiral r=119, spacing 26 | 20 | `pin.z = −1.3` ≠ `hole.z = 0` → every link lifts: the "ladder" effect | 95 KB glb |
| `dragon2.json` | spiral r=30, spacing 24.5 | 40 | `overrides[0]`: link 39 replaced by `headdragonn.obj` (its 11.6 MB mesh **not** copied) | 95 KB glb |
| `croc.json` | straight | 14 | 110 k-vertex crocodile segment (6.5 MB mesh **not** copied) | — |

## Using them in oo2

* They are already in the live database: start the server and press **Load** in the Projects step.
* To move them to another install: copy the `meshes/*.glb` into that install's `data/meshes/` and
  add each record to `data/projects.json` keyed by its `id`, or load the JSON with
  **Step 4 → Load config** (the `meshId` is fetched from `/api/meshes/<id>`).

## Config schema (version 4)

```jsonc
{
  "version": 4,
  "pin":  {"x": 5.6, "y": -0.1, "z": 0},       // mm, in the baked part frame
  "hole": {"x": -2.86, "y": 0, "z": 0},
  "partX": 0, "partY": 0, "partZ": 0,            // slider angles already applied (baked)
  "params": {"shape": "spiral", "count": 100, "startR": 26, "spacing": 12.5, "plate": 220},
  "pathCode":  "…JS body: f(t, n_it, n_it_nor, z_stack) → {x,y,z}…",
  "scaleCode": "…JS body: f(n_it, n_it_nor) → number | {x,y,z}…",
  "colorCode": "…JS body: f(n_it, n_it_nor, base) → 'invert' | colour | base…",
  "symPlanes": [{"p":[x,y,z], "n":[x,y,z]}],     // detected mirror planes
  "mirror":  {"enabled": false, "axis": "x", "offset": 0},   // half-part mirroring
  "lsNodes": [{"pos":[..],"dir":[..],"intensity":5,"radius":20,"mode":"push","falloff":"smooth","code":"return n_it_nor;"}],
  "meshId": "<uuid>.glb",                        // uploaded, already-aligned part
  "overrides": [{"index": 39, "name": "headdragonn.obj", "meshId": "<uuid>.glb", "adjust": [16 floats]}]
}
```
Older records (version < 4) lack `pathCode`/`colorCode`/`mirror`/`lsNodes`; `applyConfig` treats
every key as optional.
