/**
 * Snapmaker Orca projects with mixed filaments.
 *
 * Snapmaker Orca ("Full Spectrum") can print two loaded filaments in alternating layers and treat the result as one
 * more filament: with cyan, magenta, yellow and black loaded, a cyan/magenta mix is "filament 5", the next one
 * "filament 6", and so on. Painting on the model may name those just like the real ones.
 *
 * The mixes are print settings (`mixed_filament_definitions`), so they only travel in a project file — one that is
 * opened with File → Open project. This module plans the mixes for a list of colours and packs such a project.
 *
 * Worked out from a project saved by Snapmaker Orca 2.4.1 and from its source (src/libslic3r/MixedFilament.cpp):
 *
 *   mixed_filament_definitions = row;row;…
 *   row = a,b,enabled,custom,percentOfB,0,g,w,m2,z0,xa0,xb0,d0,o0,u<id>,cm1,<pattern>
 *         a, b      the two real filaments (1-based)
 *         pattern   one digit per layer, repeated up the print: 1 = filament a, 2 = filament b
 *         cm1       the row was made in the slicer's "cycle" mode, i.e. it comes with its own pattern
 *   The n-th row (counting the enabled ones) is filament <number of real filaments> + n.
 */
import { filamentMixerLerp } from './FilamentMixer.js';

/* how much of the second filament a mix may have: as "p layers in every q" — short cycles blend best */
const SHARES = [[1, 5], [1, 4], [1, 3], [2, 5], [1, 2], [3, 5], [2, 3], [3, 4], [4, 5]];
const MIX_PENALTY = 0.004;      // a mix costs a tool change per layer: on a near tie the plain filament wins

const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const toLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
/* sRGB (0…255) → OKLab, where plain distance is close to how different two colours look */
function oklab([r, g, b]) {
  r = toLinear(r); g = toLinear(g); b = toLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

/** p layers of filament b in every q, spread out evenly: 2 in 5 → "11212" */
export function cadence(p, q) {
  let s = '';
  for (let k = 0; k < q; k++) s += Math.floor((k + 1) * p / q) > Math.floor(k * p / q) ? '2' : '1';
  return s;
}

/**
 * For every wanted colour: the loaded filament, or the mix of two, that comes closest.
 * @param targets    wanted colours, '#RRGGBB'
 * @param filaments  the loaded filaments, '#RRGGBB' (filament 1, 2, …)
 * @returns {
 *   colours: per target { filament, hex, recipe },   filament = the number to paint with, hex = what it should look like
 *   mixes:   the mixed filaments used, in filament order: { filament, a, b, percent, pattern, hex }
 * }
 */
export function planMixes(targets, filaments) {
  const F = filaments.map(hexToRgb), options = [];
  F.forEach((c, i) => options.push({ a: i + 1, b: 0, rgb: c, lab: oklab(c), cost: 0 }));
  for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) for (const [p, q] of SHARES) {
    const rgb = filamentMixerLerp(...F[i], ...F[j], p / q);        // the slicer's own model: a = lower number, t = share of b
    options.push({ a: i + 1, b: j + 1, p, q, rgb, lab: oklab(rgb), cost: MIX_PENALTY });
  }
  const mixes = [], colours = [];
  for (const t of targets) {
    const lab = oklab(hexToRgb(t));
    let best = null, bd = Infinity;
    for (const o of options) {
      const d = Math.hypot(lab[0] - o.lab[0], lab[1] - o.lab[1], lab[2] - o.lab[2]) + o.cost;
      if (d < bd) { bd = d; best = o; }
    }
    if (!best.b) { colours.push({ filament: best.a, hex: rgbToHex(best.rgb), recipe: `filament ${best.a}` }); continue; }
    let mix = mixes.find(m => m.option === best);
    if (!mix) {
      const percent = Math.round(100 * best.p / best.q);
      mix = { option: best, filament: F.length + mixes.length + 1, a: best.a, b: best.b, percent, pattern: cadence(best.p, best.q), hex: rgbToHex(best.rgb) };
      mixes.push(mix);
    }
    colours.push({ filament: mix.filament, hex: mix.hex, recipe: `${100 - mix.percent} % filament ${mix.a} + ${mix.percent} % filament ${mix.b}` });
  }
  return { colours, mixes: mixes.map(({ option, ...m }) => m) };
}

/** the `mixed_filament_definitions` value for planMixes().mixes */
export function mixedFilamentDefinitions(mixes) {
  return mixes.map((m, i) => `${m.a},${m.b},1,1,${m.percent},0,g,w,m2,z0,xa0,xb0,d0,o0,u${101 + i},cm1,${m.pattern}`).join(';');
}

const xml = t => String(t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const uuid = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
const CORE = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

/**
 * The files of a Snapmaker Orca project, ready to be zipped ({ path: string | Uint8Array }).
 * @param o.mesh        the <mesh>…</mesh> of the chain as bytes, centred on its own middle
 * @param o.halfHeight  half the chain's height (the plate is that far below the middle)
 * @param o.title       name of the object
 * @param o.settings    project settings of a project saved by the slicer (printer, process, filaments) — the template
 * @param o.filaments   colours of the loaded filaments, '#RRGGBB'; as many as the template has
 * @param o.mixes       planMixes().mixes
 * @param o.base        the filament everything unpainted is printed with
 */
export function snapmakerProject({ mesh, halfHeight, title, settings, filaments, mixes, base }) {
  const enc = new TextEncoder(), name = xml(title), objPath = '/3D/Objects/chain_1.model';
  const app = 'Snapmaker_Orca-' + (settings.version || '2.4.1');
  /* the middle of the bed: where the object is put */
  const pts = (settings.printable_area || []).map(p => String(p).split('x').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
  const cx = pts.length ? (Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[0]))) / 2 : 135;
  const cy = pts.length ? (Math.min(...pts.map(p => p[1])) + Math.max(...pts.map(p => p[1]))) / 2 : 135;
  const place = `1 0 0 0 1 0 0 0 1 ${+cx.toFixed(4)} ${+cy.toFixed(4)} ${+halfHeight.toFixed(4)}`;

  const cfg = { ...settings };
  cfg.filament_colour = filaments.slice();
  if (Array.isArray(cfg.filament_multi_colors)) cfg.filament_multi_colors = filaments.slice();
  cfg.mixed_filament_definitions = mixedFilamentDefinitions(mixes);
  if (Array.isArray(cfg.different_settings_to_system)) {         // the mixes are a change to the process preset — say so, or the slicer takes the stock preset
    const d = cfg.different_settings_to_system.slice(), keys = new Set(String(d[0] || '').split(';').filter(Boolean));
    if (mixes.length) keys.add('mixed_filament_definitions'); else keys.delete('mixed_filament_definitions');
    d[0] = [...keys].join(';'); cfg.different_settings_to_system = d;
  }

  const head = enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${CORE}>
 <metadata name="Snapmaker_Orca:3mfVersion">1</metadata>
 <resources>
  <object id="1" p:UUID="${uuid()}" type="model">
`), tail = enc.encode(`  </object>
 </resources>
 <build/>
</model>
`);
  const object = new Uint8Array(head.length + mesh.length + tail.length);
  object.set(head, 0); object.set(mesh, head.length); object.set(tail, head.length + mesh.length);

  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="application/xml"/>
</Types>
`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`,
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${CORE}>
 <metadata name="Application">${xml(app)}</metadata>
 <metadata name="Snapmaker_Orca:3mfVersion">1</metadata>
 <metadata name="Title">${name}</metadata>
 <resources>
  <object id="2" p:UUID="${uuid()}" type="model">
   <components>
    <component p:path="${objPath}" objectid="1" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid()}">
  <item objectid="2" p:UUID="${uuid()}" transform="${place}" printable="1"/>
 </build>
</model>
`,
    '3D/_rels/3dmodel.model.rels': `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="${objPath}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`,
    [objPath.slice(1)]: object,
    'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="${name}"/>
    <metadata key="extruder" value="${base}"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="${name}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="${+halfHeight.toFixed(4)}"/>
      <metadata key="extruder" value="${base}"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 ${+halfHeight.toFixed(4)}" offset="0 0 0" />
  </assemble>
</config>
`,
    'Metadata/project_settings.config': JSON.stringify(cfg, null, 4),
  };
}
