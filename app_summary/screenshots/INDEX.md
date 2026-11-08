# Screenshot index

All shots are 1800×1050 from headless Chrome unless noted. Project used for the full walkthrough:
**longchain** (torus-like link, spiral, 100 links). Other projects show chain results only.

## Empty state & projects
| File | Shows |
|---|---|
| `00_empty_state_step1.png` | Fresh app: step 1 panel, drop zone in viewport |
| `01_projects_panel.png` | Projects step: save-as-new / update / list of 35 saved projects with Load / delete |

## Step 3 — Build chain (longchain)
| File | Shows |
|---|---|
| `10_longchain_step3_chain_iso.png` | Spiral of 100 links, colour formula alternates green/purple, HUD "no overlaps · 290 pairs tested", chain length 846 mm |
| `11_longchain_step3_chain_top.png` | Same from the top |
| `12_longchain_xray.png` | X-ray toggle: translucent links |
| `13_longchain_section_view.png` | Section toggle, Z-cut slider at mid height: links cut open |
| `13b_longchain_section_top.png` | Section from the top |

## Step 1 — Upload & align (longchain part)
| File | Shows |
|---|---|
| `14_longchain_step1_part_wireframe.png` | Wireframe overlay on the single part |
| `15_longchain_step1_part_vertices.png` | Vertex points overlay |
| `16_longchain_step1_symmetry_lines.png` | "Find mirror lines" result: magenta mirror plane, status "Found 1 mirror line (RMS error 0.0%)" |

## Step 2 — Mark pin & hole
| File | Shows |
|---|---|
| `17_longchain_step2_pin_hole_mate.png` | Red pin / blue hole cylinders, orange translucent mated neighbour, "✓ neighbour clears" |
| `18_longchain_step2_top.png` | Top view of the same |
| `42_croc_step2_pin_hole.png` | Same step on the heavy crocodile segment |

## Sculpt step
| File | Shows |
|---|---|
| `19_longchain_sculpt_step_brush_cursor.png` | Sculpt panel (Draw/Carve/Smooth, radius, strength, mirror options, undo/redo, repair) and the blue ring cursor on the mesh |
| `20_longchain_sculpt_after_stroke.png` | After one mirrored Draw stroke (wireframe on): bulge on both sides of the magenta plane |

## Heightmap step
| File | Shows |
|---|---|
| `21_longchain_heightmap_step.png` | Heightmap panel (image, displacement strength/direction/mapping/axis, brush radius/flow/erase, smooth/clear mask, history); orange ring cursor |

## Loop sculpting step
| File | Shows |
|---|---|
| `22_longchain_loopsculpt_node.png` | A node placed by clicking: rotate gizmo, falloff sphere wireframe, node list and parameters (push / inflate / pinch, falloff, intensity formula presets, preview slider) |
| `23_longchain_loopsculpt_preview_t1.png` | Inflate node, preview at n_it_nor = 1: the link is inflated at the node |
| `24_longchain_step3_with_loopsculpt_progression.png` | Chain with that node: links grow progressively along the spiral |
| `25_longchain_step3_loopsculpt_top.png` | Same from the top |

## Step 4 — Export
| File | Shows |
|---|---|
| `26_longchain_step4_export.png` | Export panel: swap individual links, download button in the source format, save/load config |

## Other example projects (step 3 results)
| File | Project | Notes |
|---|---|---|
| `30_…` / `31_…ultralongversion` | 244 links, 1.30 m chain | largest example |
| `32_…` / `33_…fish` | 24 fish segments, spiral | |
| `34_…` / `35_…drag2` | 35 dragon segments, spiral | |
| `36_…` / `37_…shartk2` | 20 links, pin z ≠ hole z | each link lifts 1.3 mm → ladder; exceeds plate warning |
| `38_…` / `39_…dragon2`, `39b_dragon2_xray_top_collisions.png` | 40 links, link 39 swapped for a head model | HUD "✗ 2 links overlap"; x-ray top view shows pins through holes |
| `40_…` / `41_…croc` | straight chain, 14 links, 110 k-vertex part | |

## Panel captures (tall, 2600 px viewport, panel element only)
`panel_s1.png`, `panel_sculpt.png`, `panel_height.png`, `panel_lsculpt.png`, `panel_s2.png`,
`panel_s3.png`, `panel_s4.png` — every control of each step, for UI reference.
