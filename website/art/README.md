# Lore archive sculpture

`create-archive.py` procedurally builds the archive sculpture in Blender and
writes the review render, editable `.blend`, and web GLB to the paths below.

- `../public/images/archive.png` — 1000 × 1000 RGBA studio render
- `../public/models/archive.glb` — optimized web model
- `archive.blend` — authored Blender scene

The asset is self-generated for Lore. Geometry, materials, and lighting are
original procedural work and may be used under the repository's project
license. Run from the repository root with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python website/art/create-archive.py
```

The sculpture is authored upright in Blender's Z-up scene and exported through
the glTF exporter, which presents it upright in the glTF Y-up coordinate
system. Meshes use `page_*`, `memory_*`, and `ring_*` names for future web
animation hooks.

The homepage still (`../src/assets/hero-archive.png`) is the detailed
Image Gen artwork extracted from the approved visual concept, using the
built-in image-generation tool. The interactive GLB is a lighter procedural
Blender interpretation of that sculpture. The guide illustration uses the
Blender render so its still and live views share the same geometry.

The final image prompt preserved the concept’s bronze armature, textured ivory
paper, amber cores, and low round base, and replaced the background with solid
warm ivory `#f3efe5`. Only this final artwork ships; concept screenshots and
discarded image attempts are not website assets.
