# oo2
helper to orient 3d objects in a repetitive pattern array so that they dont touch

## run
`deno task start` → http://localhost:8005

## how the ui is organised
four steps, shown in the bar at the top of the side panel; each page has one main button bottom right.

1. **Part** — load one link, lay it flat ("Pick the bottom face" = one click on the part).
   everything else (fine rotation, flatten bottom, symmetry / half part, colours, file units) is folded away.
   the part is never reduced: it keeps every vertex of the file you loaded.
   the optional extras live here too: Sculpt, Relief from an image, Morph along the chain, Add an object.
2. **Joints** — the next link starts exactly on top of the part; move it along X / Y (arrows in the view, or the sliders)
   until the fit check says the two no longer touch. height step and pivot point are folded away.
3. **Chain** — shape + number of links, with a status card (length, overlaps, plate fit).
   **⇄ Reverse** builds the chain the other way round: same path, every link turned half a turn (also on the Export page).
   fine-tune joints, size / colour along the chain (preset buttons + code) and the custom path are folded away.
4. **Export** — file format + download; swapping individual links is folded away.
   **Smaller file** (off by default) writes every link with at most N vertices — only the downloaded file is reduced,
   the part and the chain in the app keep their detail. the page shows how big the file will be either way.

projects (open / save / delete, project file .json) are behind the **Projects** / **Save** buttons in the header.

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