# oo2
helper to orient 3d objects in a repetitive pattern array so that they dont touch

## run
`deno task start` → http://localhost:8005

## how the ui is organised
four steps, shown in the bar at the top of the side panel; each page has one main button bottom right.

1. **Part** — load one link, lay it flat ("Pick the bottom face" = one click on the part).
   everything else (fine rotation, flatten bottom, symmetry / half part, colours, file units) is folded away.
   the part is never reduced: it keeps every vertex of the file you loaded (see "detail" below).
   **Flatten the bottom**: the cut plane starts through the middle of the part; drag its arrow up or down in the view (or use
   the slider). what would be cut off is shown in red, the edge of the new bottom as a bright line. "Use this cut" stores the
   height as a setting: the part itself stays whole (in the tools and in the saved project) — the links are cut when the chain
   is built, and set down flat on the plate.
   the optional extras live here too: Sculpt, Relief from an image, Morph along the chain, Add an object.
   a morph point has one handle for everything: arrows move it, rings turn its arrow, the ball in the middle moves it freely.
   its amount slider goes from 0 to 200 mm (the number field also takes a negative amount).
   a morph point can be **mirrored** ("Mirror to the other side"): it then acts a second time across the part's mirror plane —
   the detected symmetry line (found on the first tick), or a plane set by hand; on a half part its own mirror plane.
2. **Joints** — the next link starts exactly on top of the part; move it along X / Y (arrows in the view, or the sliders)
   until the fit check says the two no longer touch. height step and pivot point are folded away.
3. **Chain** — shape + number of links, with a status card (length, overlaps, plate fit).
   overlapping links turn red, and the view shows where: a yellow line along which the two surfaces cross and a ring around
   every such place; "Show where" goes from one to the next. the Joints page shows the same for the part and its neighbour.
   **⇄ Reverse** builds the chain the other way round: same path, every link turned half a turn (also on the Export page).
   fine-tune joints, size / colour along the chain (preset buttons + code), the custom path and **Fast preview** are folded away.
4. **Export** — file format + download; swapping individual links is folded away.
   **Detail** says how much of the part goes into the file — the page shows the vertices per link and the file size for each:
   **Full** (the default) every vertex · **Fine** leaves vertices out only where the surface hardly moves, and says by how
   much (measured; on the parts tried at most 0.02 mm, 0.002 mm on average — the file of a densely meshed part gets up to
   8 × smaller, a part that is light already stays as it is) · **Vertex limit** at most N vertices per link.
   the choice is remembered, like the file format.
   formats: STL, **3MF**, OBJ, GLB, PLY. 3MF carries colours the way Snapmaker Orca / OrcaSlicer / Bambu Studio keep colour
   painting: every triangle names its filament (most used colour = filament 1). import it with File → Import.
   **At most N colours** (on, 4) merges similar colours until N are left — one per filament; the page lists them, numbered.
   a part without colours of its own still gets them in the file once "Colour along the chain" returns a colour for a link
   (Two colours, Gradient, Rainbow …): one colour per link.
   **Mix the colours from the loaded filaments** (3MF, Snapmaker Orca): the colours are not filaments of their own but made
   from the ones in the printer (default cyan, magenta, yellow, black): each colour is printed with one filament, or with two
   in alternating layers — the slicer's mixed filaments ("filament 5, 6 …"). the page shows, per colour, the mix and what it
   should look like (same colour model as the slicer). this writes a slicer *project*: open it with File → Open project.
   its printer / process / filament settings come from `slicer/snapmaker_u1_project_settings.json` (the project settings of a
   project saved by Snapmaker Orca 2.4.1 — replace the file with the `Metadata/project_settings.config` of another project to
   change them). see `slicer/OrcaProject.js` for the file format.

projects (open / save / delete, project file .json) are behind the **Projects** / **Save** buttons in the header.

**detail** — there are three levels, and only the first one is ever saved:
- the **part** keeps every vertex. the part tools work on it, the overlap check tests it, the file is made from it.
- the **chain in the view** is drawn from a light copy of the link (Chain → Fast preview: at most 4,000 vertices per link,
  on by default; remembered per browser). a detailed link drawn once per place in the chain is what made the view slow —
  50 links of 270,000 triangles are 13 million triangles per frame, and a morphed chain needs a copy of the link per place.
  the chip in the view says "… verts per link · drawn with …" whenever the picture is lighter than the part.
  where two links overlap is still decided on the full meshes; only the yellow line is drawn from the light copies.
- the **file** is made from the part itself, never from the preview (Export → Detail, above).

the view shows the **print bed**: the plate (256 × 256 mm by default; Chain → Print bed), a line every 10 mm, stronger every 50 mm.
it is drawn centred under the chain (under the part on the other pages), so whatever sticks out over its edge doesn't fit —
the edge turns yellow then. seen from below the plate is hidden, so the underside of a part stays visible.
projects saved earlier keep the bed size they were saved with (220).

the 3d view always looks at — and orbits around — the middle of what the page shows (part, part + next link, chain),
and keeps doing so while that changes (more links, other shape, turned part). right-drag moves the view away on purpose;
Iso / Top / Front / Side or the cube bring it back.

if the browser takes the WebGL context away (graphics driver reset, its GPU process crashing — on some linux + nvidia
machines when the screen is locked), the view says so and draws again by itself once the context is back.
if it doesn't come back: Save → reload the page → restart the browser (chrome: `chrome://restart`).
a browser with no WebGL at all gets an explanation instead of a dead page.



# todo 
orthographic view. 

allow replacement of part (load object, load a different 3d model, 3d part should be replaced but all other project configs should stay)