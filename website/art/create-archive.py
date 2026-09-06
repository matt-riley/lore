"""Procedurally build Lore's archive sculpture.

Run with Blender 4.x:
  blender -b --python website/art/create-archive.py

Outputs are written relative to the repository root. All geometry and materials
are self-generated and are released with the Lore project.
"""
import bpy
import math
import os
import random
from mathutils import Vector

random.seed(23)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
MODEL_PATH = os.path.join(ROOT, "website/public/models/archive.glb")
IMAGE_PATH = os.path.join(ROOT, "website/public/images/archive.png")
BLEND_PATH = os.path.join(ROOT, "website/art/archive.blend")

def mat(name, color, metallic=0.0, roughness=0.45, transmission=0.0, ior=1.45):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bs = m.node_tree.nodes.get("Principled BSDF")
    bs.inputs["Base Color"].default_value = (*color, 1)
    bs.inputs["Metallic"].default_value = metallic
    bs.inputs["Roughness"].default_value = roughness
    if "Transmission Weight" in bs.inputs:
        bs.inputs["Transmission Weight"].default_value = transmission
    if "IOR" in bs.inputs:
        bs.inputs["IOR"].default_value = ior
    if name in ("Ivory paper", "Aged bronze", "Bronze shadow"):
        tex = m.node_tree.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = 5.5 if name == "Ivory paper" else 7.0; tex.inputs["Detail"].default_value = 3.0; tex.inputs["Roughness"].default_value = .72
        bump = m.node_tree.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = .12 if name == "Ivory paper" else .08; bump.inputs["Distance"].default_value = .035 if name == "Ivory paper" else .02
        m.node_tree.links.new(tex.outputs["Fac"], bump.inputs["Height"]); m.node_tree.links.new(bump.outputs["Normal"], bs.inputs["Normal"])
    return m

paper = mat("Ivory paper", (0.82, 0.75, 0.62), 0, 0.64)
paper_edge = mat("Paper edge", (0.48, 0.38, 0.25), 0, 0.72)
bronze = mat("Aged bronze", (0.18, 0.065, 0.018), 0.82, 0.4)
bronze_dark = mat("Bronze shadow", (0.055, 0.018, 0.006), 0.78, 0.42)
brass = mat("Warm brass", (0.55, 0.27, 0.055), 0.9, 0.2)
amber = mat("Amber glass", (0.48, 0.105, 0.018), 0.12, 0.17, 0.38, 1.48)
floor_mat = mat("Warm studio floor", (0.91, 0.875, 0.80), 0, 0.72)

def assign(obj, material):
    obj.data.materials.append(material)
    return obj

def cube(name, loc, scale, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object; o.name = name; o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(o, material)
    if bevel:
        mod = o.modifiers.new("soft edges", "BEVEL"); mod.width = bevel; mod.segments = 2
    return o

def cyl(name, loc, radius, depth, material, vertices=32, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    o = bpy.context.object; o.name = name; assign(o, material)
    if material in (bronze, bronze_dark, brass, amber):
        for p in o.data.polygons: p.use_smooth=True
    if bevel:
        mod=o.modifiers.new("turned edge", "BEVEL"); mod.width=bevel; mod.segments=2
    return o

def rod(name, a, b, radius, material):
    a, b = Vector(a), Vector(b); d = b-a
    o = cyl(name, (a+b)/2, radius, d.length, material, 16, radius*0.45)
    o.rotation_mode='QUATERNION'; o.rotation_quaternion=d.to_track_quat('Z','Y')
    return o

def page(name, z, w, d, angle, seed):
    rng=random.Random(seed)
    # A shallow irregular octagon, with uneven corners for a handmade torn sheet.
    pts=[(-w*.50+rng.uniform(-.07,.05),-d*.40+rng.uniform(-.06,.04)),
         (-w*.34+rng.uniform(-.08,.08),-d*.51+rng.uniform(-.04,.04)),
         (-w*.02+rng.uniform(-.08,.08),-d*.47+rng.uniform(-.05,.04)),
         (w*.40+rng.uniform(-.05,.06),-d*.42+rng.uniform(-.05,.04)),
         (w*.52+rng.uniform(-.04,.05),-d*.12+rng.uniform(-.06,.06)),
         (w*.45+rng.uniform(-.06,.05),d*.28+rng.uniform(-.05,.06)),
         (w*.22+rng.uniform(-.08,.06),d*.51+rng.uniform(-.05,.04)),
         (-w*.18+rng.uniform(-.08,.08),d*.46+rng.uniform(-.05,.05)),
         (-w*.46+rng.uniform(-.06,.05),d*.24+rng.uniform(-.06,.05)),
         (-w*.53+rng.uniform(-.05,.04),-d*.10+rng.uniform(-.06,.05))]
    verts=[(x,y,-.028 + .018*math.sin(x*2.2) + .010*math.sin(y*3.1)) for x,y in pts]+[(x,y,.028 + .018*math.sin(x*2.2) + .010*math.sin(y*3.1)) for x,y in pts]
    n=len(pts); faces=[tuple(range(n)), tuple(range(n,2*n))[::-1]]
    for i in range(n): faces.append((i,(i+1)%n,(i+1)%n+n,i+n))
    me=bpy.data.meshes.new(name+" mesh"); me.from_pydata(verts,[],faces); me.materials.append(paper); me.materials.append(paper_edge)
    o=bpy.data.objects.new(name,me); bpy.context.collection.objects.link(o); o.location=(0,0,z); o.rotation_euler[2]=angle
    for p in me.polygons: p.material_index=0 if p.index<2 else 1
    bevel=o.modifiers.new("deckled softness","BEVEL"); bevel.width=.018; bevel.segments=2
    return o

def ring(name, major, minor, z=2.9):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=128, minor_segments=16, location=(0,-.65,z), rotation=(math.pi/2,0,0))
    o=bpy.context.object; o.name=name; assign(o,bronze)
    for p in o.data.polygons: p.use_smooth=True
    return o

# Clean scene
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
    pass

# Plinth and sculpture frame
cyl("base_disk", (0,0,0.12), 1.66, .22, bronze_dark, 64, .07)
cyl("base_inlay", (0,0,0.25), 1.53, .05, bronze, 64, .022)
ring("ring_outer", 2.03, .065, 2.72)
ring("ring_inner", 1.88, .018, 2.72)

# Pages float in a slightly irregular archive stack.
zs=[0.95,1.14,1.49,1.68,2.03,2.22,2.57,2.76,3.11,3.30,3.65,3.84,4.13,4.28]
for i,z in enumerate(zs):
    t=i/(len(zs)-1); width=2.10 + 0.90*math.sin(math.pi*t)
    page(f"page_{i+1:02d}", z+random.uniform(-.025,.025), width+random.uniform(-.08,.08), 1.60+1.0*math.sin(math.pi*t)+random.uniform(-.06,.06), random.uniform(-.11,.11), 100+i)

# Vertical pins visibly carry the sheets and echo the ring armature.
for x,y in [(-1.43,-.60),(1.43,-.60),(-1.30,.62),(1.30,.62)]:
    rod("ring_post", (x,y,.58), (x,y,4.35), .026, bronze_dark)
    cyl("brass_fastener", (x,y,.38), .085, .045, brass, 24, .018)
    cyl("brass_fastener", (x,y,3.21), .085, .045, brass, 24, .018)

# Amber memory cores tucked between selected pages.
for i,(x,y,z,s) in enumerate([(-.55,-.60,1.32,.90),(.50,-.60,1.86,.82),(-.42,-.60,2.40,.86),(.48,-.60,2.95,.94),(-.10,-.60,3.50,.76)]):
    o=cyl(f"memory_{i+1:02d}",(x,y,z),.21*s,.32*s,amber,32,.04*s)
    o.rotation_euler[1]=random.uniform(-.08,.08)
    cyl(f"memory_cap_{i+1:02d}",(x,y,z+.17*s),.15*s,.03*s,brass,24,.014*s)

# Small feet and top clasp establish crafted construction.
for x in (-1.43,1.43):
    cyl("frame_foot",(x,-.60,.37),.12,.10,brass,24,.018)
cyl("ring_clasp",(0,-.65,4.76),.18,.18,brass,32,.035)

# Floor for soft studio contact; cycles shadow catcher preserves alpha.
bpy.ops.mesh.primitive_plane_add(size=200, location=(0,0,0))
floor=bpy.context.object; floor.name="studio_shadow_floor"; assign(floor,floor_mat)
floor.hide_render=True
try: floor.is_shadow_catcher=True
except Exception: pass

# Camera, 3/4 product view with ample margin.
bpy.ops.object.camera_add(location=(4.0,-10.0,5.0))
cam=bpy.context.object; cam.name="Archive_Camera"; bpy.context.scene.camera=cam
target=Vector((0,0,2.35)); cam.rotation_euler=(target- cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.lens=58

def area(name, loc, energy, size, color):
    bpy.ops.object.light_add(type='AREA', location=loc); l=bpy.context.object; l.name=name; l.data.energy=energy; l.data.shape='DISK'; l.data.size=size; l.data.color=color; l.rotation_euler=(target-l.location).to_track_quat('-Z','Y').to_euler(); return l
area("key_softbox",(4,-4,7),900,4.5,(1.0,.82,.62))
area("fill_softbox",(-4,-2,4),620,5.0,(.64,.75,1.0))
area("rim_light",(1,4,6),1050,3.0,(1.0,.48,.20))

scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.samples=64
scene.cycles.use_denoising=True
scene.cycles.max_bounces=5
scene.render.resolution_x=1000; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'; scene.render.film_transparent=True
scene.render.filepath=IMAGE_PATH
scene.render.image_settings.color_depth='8'
scene.world.color=(0.055,0.035,0.02)
scene.view_settings.look='AgX - Medium High Contrast'

# Export the authored scene for future edits, then a compact GLB for the site.
os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True); os.makedirs(os.path.dirname(IMAGE_PATH), exist_ok=True)
# Export only authored sculpture meshes; the camera, lights, and shadow floor
# belong to the render scene and are intentionally absent from the web model.
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.context.scene.objects:
    if o.type == 'MESH' and o.name != 'studio_shadow_floor': o.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects.get('ring_outer')
bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
bpy.ops.export_scene.gltf(filepath=MODEL_PATH, export_format='GLB', export_apply=True, export_materials='EXPORT', export_cameras=False, export_lights=False, use_selection=True)
bpy.ops.render.render(write_still=True)
print(f"ARCHIVE_OUTPUT blend={BLEND_PATH} glb={MODEL_PATH} png={IMAGE_PATH}")
