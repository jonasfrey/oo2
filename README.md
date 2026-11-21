# oo2
helper to orient 3d objects in a repetitive pattern array so that they dont touch

## run
`deno task start` → http://localhost:8005

## how the ui is organised
four steps, shown in the bar at the top of the side panel; each page has one main button bottom right.

1. **Part** — load one link, lay it flat ("Pick the bottom face" = one click on the part).
   everything else (fine rotation, flatten bottom, detail level, symmetry / half part, colours, file units) is folded away.
   the optional extras live here too: Sculpt, Relief from an image, Morph along the chain, Add an object.
2. **Joints** — drag the red pin / blue hole markers; the fit check shows whether the next link touches.
3. **Chain** — shape + number of links, with a status card (length, overlaps, plate fit).
   fine-tune joints, size / colour along the chain (preset buttons + code) and the custom path are folded away.
4. **Export** — file format + download; swapping individual links is folded away.

projects (open / save / delete, project file .json) are behind the **Projects** / **Save** buttons in the header.



# todo 
orthographic view. 

allow replacement of part (load object, load a different 3d model, 3d part should be replaced but all other project configs should stay)