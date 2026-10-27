# Seal, remesh and re-bake a dense generated mesh into low-poly tiers.
#
#   blender --background --factory-startup --python tools/mesh/remesh.py -- \
#     --in dense.glb --out-prefix out/x --tiers 2000,1000,500 [--tex 512] [--seal-res 128,96,64,48]
#     [--ray m [--ray-far m]] [--cage m] [--focus z>0.85:4]
#
# Writes <out-prefix>-<tris>.glb per tier and prints one `remesh: {json}` line
# per tier. Design: design/43-remesh.md.

import argparse
import json
import os
import re
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '.pydeps'))
try:
    import xatlas
except ImportError:
    raise SystemExit('remesh: xatlas is missing; run `npm run mesh:pydeps`')


def args():
    p = argparse.ArgumentParser()
    p.add_argument('--in', dest='src', required=True)
    p.add_argument('--out-prefix', required=True)
    p.add_argument('--tiers', required=True)
    p.add_argument('--tex', type=int, default=512)
    p.add_argument('--padding', type=int, default=4, help='texels between UV charts at --tex')
    p.add_argument('--seal-res', default='128,96,64,48', help='raster seal resolutions, finest first')
    p.add_argument('--max-crossings', type=float, default=0.02, help='fraction of tier tris')
    p.add_argument('--min-part', type=float, default=0.002)
    p.add_argument('--close', type=int, default=2, help='voxels; leaks up to twice this are shut')
    p.add_argument('--ray', type=float, help='bake max ray distance in metres; default 0.08 x the longest side')
    p.add_argument('--ray-far', type=float, help='metres; texels the --ray bake missed take this longer bake')
    p.add_argument('--cage', type=float, help='bake cage extrusion in metres; default 0.03 x the longest side')
    p.add_argument('--normals', default='smooth', help='smooth | weighted | transfer | angle:<deg>')
    p.add_argument('--focus', help='<axis><op><fraction>:<strength>, e.g. z>0.85:4 -- collapse spares that slab of the bbox')
    return p.parse_args(sys.argv[sys.argv.index('--') + 1:])


def parse_focus(spec):
    m = re.fullmatch(r'([xyz])([<>])([0-9.]+):([0-9.]+)', spec)
    if not m:
        raise SystemExit(f'remesh: bad --focus "{spec}"; want e.g. z>0.85:4')
    return {'axis': 'xyz'.index(m[1]), 'above': m[2] == '>', 'at': float(m[3]), 'strength': float(m[4])}


def in_focus(obj, focus):
    co = np.empty(len(obj.data.vertices) * 3, np.float32)
    obj.data.vertices.foreach_get('co', co)
    v = co.reshape(-1, 3)[:, focus['axis']]
    cut = v.min() + focus['at'] * (v.max() - v.min())
    return v > cut if focus['above'] else v < cut


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def import_dense(path):
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError(f'{path} has no mesh')
    for o in meshes:
        activate(o)
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    src = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    src.name = 'dense'
    return src


def topology(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    open_edges = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    nonmanifold = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    bm.free()
    return open_edges, nonmanifold


def drop_small_parts(obj, min_fraction):
    # Voxel output splits whiskers and spray into separate blobs; drop them.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, parts = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, part = [f], []
        seen.add(f.index)
        while stack:
            x = stack.pop()
            part.append(x)
            for e in x.edges:
                for y in e.link_faces:
                    if y.index not in seen:
                        seen.add(y.index)
                        stack.append(y)
        parts.append(part)
    areas = [sum(f.calc_area() for f in p) for p in parts]
    small = [p for p, a in zip(parts, areas) if a < min_fraction * sum(areas)]
    bmesh.ops.delete(bm, geom=[f for p in small for f in p], context='FACES')
    bm.to_mesh(obj.data)
    bm.free()
    return len(parts), len(small)


def dilate(a):
    b = a.copy()
    b[1:] |= a[:-1]
    b[:-1] |= a[1:]
    b[:, 1:] |= a[:, :-1]
    b[:, :-1] |= a[:, 1:]
    b[:, :, 1:] |= a[:, :, :-1]
    b[:, :, :-1] |= a[:, :, 1:]
    return b


def surface_samples(me, step):
    # Points on every triangle no further apart than `step`.
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    tri = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', tri)
    a, b, c = (co[tri.reshape(-1, 3)[:, i]] for i in range(3))
    edge = np.maximum.reduce([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)])
    n = np.ceil(edge / step).astype(np.int32)
    pts = [co]
    for k in np.unique(n[n > 1]):
        sel = n == k
        u, v = np.meshgrid(np.arange(k + 1), np.arange(k + 1), indexing='ij')
        keep = u + v <= k
        u, v = u[keep] / k, v[keep] / k
        pts.append((a[sel, None] * (1 - u - v)[:, None] + b[sel, None] * u[:, None] + c[sel, None] * v[:, None]).reshape(-1, 3))
    return np.concatenate(pts)


def erode(a):
    return ~dilate(~a)


def flood_outside(free):
    outside = np.zeros(free.shape, bool)
    for face in (np.s_[0], np.s_[-1], np.s_[:, 0], np.s_[:, -1], np.s_[:, :, 0], np.s_[:, :, -1]):
        outside[face] = free[face]
    while True:
        grown = dilate(outside) & free
        if np.array_equal(grown, outside):
            return outside
        outside = grown


def repeat(op, a, n):
    for _ in range(n):
        a = op(a)
    return a


def solid_grid(dense, res, close):
    # Generated bodies are often a thick hollow shell whose cavity leaks to the
    # outside, so OpenVDB's inside test (and ray parity) leave them hollow. A
    # morphological close shuts the leak but also bridges every gap under
    # 2*close voxels: fused arms, webbed feathers. So the close only finds what
    # it would add, and of that only the fat part (a cavity survives an
    # opening, a slit between limbs doesn't) joins the solid.
    co = np.array([v.co for v in dense.data.vertices], np.float32)
    lo, hi = co.min(0), co.max(0)
    cell = float((hi - lo).max()) / res
    pad = close + 2
    origin = lo - pad * cell
    dims = np.ceil((hi - lo) / cell).astype(int) + 2 * pad + 1
    shell = np.zeros(dims, bool)
    ijk = np.floor((surface_samples(dense.data, cell * 0.5) - origin) / cell).astype(int)
    shell[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    tight = ~flood_outside(~shell)
    closed = ~repeat(dilate, flood_outside(~repeat(dilate, shell, close)), close)
    added = closed & ~tight
    fat = repeat(dilate, repeat(erode, added, close), close) & added
    return tight | fat, origin, cell, int(added.sum()), int(fat.sum())


def grid_mesh(solid, origin, cell, name):
    # Boundary quads of the solid voxels, wound outward.
    nx, ny, nz = solid.shape
    vid = lambda i, j, k: (i * (ny + 1) + j) * (nz + 1) + k
    quads = []
    for axis in range(3):
        a = solid.transpose(axis, (axis + 1) % 3, (axis + 2) % 3)
        diff = a[1:].astype(np.int8) - a[:-1].astype(np.int8)
        for sign in (1, -1):
            idx = np.argwhere(diff == -sign)
            p, q, r = idx[:, 0] + 1, idx[:, 1], idx[:, 2]
            corners = [(p, q, r), (p, q + 1, r), (p, q + 1, r + 1), (p, q, r + 1)]
            if sign < 0:
                corners.reverse()
            back = lambda c: [c[(i - axis) % 3] for i in range(3)]
            quads.append(np.stack([vid(*back(c)) for c in corners], 1))
    quads = np.concatenate(quads)
    used, inverse = np.unique(quads, return_inverse=True)
    k = used % (nz + 1)
    j = (used // (nz + 1)) % (ny + 1)
    i = used // ((nz + 1) * (ny + 1))
    verts = origin + np.stack([i, j, k], 1) * cell
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], inverse.reshape(-1, 4).tolist())
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return obj


def copy_of(obj, name):
    c = obj.copy()
    c.data = obj.data.copy()
    c.name = name
    bpy.context.collection.objects.link(c)
    activate(c)
    return c


def voxel(obj, res, min_part):
    activate(obj)
    mod = obj.modifiers.new('voxel', 'REMESH')
    mod.mode = 'VOXEL'
    mod.voxel_size = max(obj.dimensions) / res
    mod.adaptivity = 0
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return drop_small_parts(obj, min_part)


def seal(dense, res, min_part, close):
    # OpenVDB at twice the raster resolution only smooths the voxel steps; at
    # or below it, it would re-sample thin sheets and cut holes (DESIGN §43).
    solid, origin, cell, added, kept = solid_grid(dense, res, close)
    sealed = grid_mesh(solid, origin, cell, f'sealed{res}')
    parts, dropped = voxel(sealed, 2 * res, min_part)
    triangulate(sealed)
    chi = len(sealed.data.vertices) - len(sealed.data.edges) + len(sealed.data.polygons)
    return sealed, {'res': res, 'parts': parts, 'droppedParts': dropped, 'closeAdded': added, 'closeKept': kept,
                    'sealedFaces': len(sealed.data.polygons), 'genus': parts - dropped - chi // 2}


def triangulate(obj):
    mod = obj.modifiers.new('tri', 'TRIANGULATE')
    mod.quad_method = 'BEAUTY'
    bpy.ops.object.modifier_apply(modifier=mod.name)


def self_intersections(obj):
    # Collapse never joins or opens surfaces, but at a small budget it can fold
    # one through a neighbour; count face pairs that cross without sharing a vertex.
    tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
    polys = obj.data.polygons
    return sum(1 for a, b in tree.overlap(tree) if a < b and not set(polys[a].vertices) & set(polys[b].vertices))


def focus_share(obj, focus):
    c = np.empty(len(obj.data.polygons) * 3, np.float32)
    obj.data.polygons.foreach_get('center', c)
    v = c.reshape(-1, 3)[:, focus['axis']]
    lo, hi = obj.bound_box[0][focus['axis']], obj.bound_box[6][focus['axis']]
    cut = lo + focus['at'] * (hi - lo)
    return float(np.mean(v > cut if focus['above'] else v < cut))


def remesh_tier(sealed, tris, focus):
    # Quadric collapse straight from the sealed voxel surface: it only merges
    # vertices an edge already joins, so it can neither bridge two surfaces nor
    # cut a hole, and the even voxel input keeps triangles even. Voxelizing
    # again at the tier's scale would do both (DESIGN §43).
    low = copy_of(sealed, f'low{tris}')
    mod = low.modifiers.new('collapse', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = min(1.0, tris / len(low.data.polygons))
    if focus:
        # Collapse never moves a weight-0 vertex and penalises low weights, so
        # every vertex is in the group: 1 outside the slab, 1/strength inside.
        # That is not a density ratio; the tier reports the gain it reached.
        group = low.vertex_groups.new(name='focus')
        inside = in_focus(low, focus)
        group.add([int(i) for i in np.flatnonzero(~inside)], 1.0, 'REPLACE')
        group.add([int(i) for i in np.flatnonzero(inside)], 1.0 / focus['strength'], 'REPLACE')
        mod.vertex_group = group.name
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in low.data.polygons:
        p.use_smooth = True
    return low


def unwrap(obj, px, padding):
    # xatlas grows fewer, rounder charts than smart_project and packs them by
    # shape, so about 60% of the image is surface rather than 20-45% (DESIGN §43).
    me = obj.data
    if any(p.loop_total != 3 for p in me.polygons):
        raise RuntimeError(f'{obj.name} is not all triangles')
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    tri = np.empty(len(me.polygons) * 3, np.uint32)
    me.polygons.foreach_get('vertices', tri)
    tri = tri.reshape(-1, 3)
    atlas = xatlas.Atlas()
    atlas.add_mesh(co.reshape(-1, 3), tri)
    pack = xatlas.PackOptions()
    pack.resolution = px
    pack.padding = padding
    pack.bruteForce = True
    atlas.generate(xatlas.ChartOptions(), pack)
    if atlas.atlas_count != 1:
        raise RuntimeError(f'xatlas split {obj.name} over {atlas.atlas_count} atlases')
    vmap, idx, uv = atlas[0]
    if not np.array_equal(vmap[idx], tri):
        raise RuntimeError('xatlas reordered faces or corners')
    starts = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_start', starts)
    loop_uv = np.empty((len(me.loops), 2), np.float32)
    loop_uv[starts[:, None] + np.arange(3)] = uv[idx]
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    me.uv_layers.new(name='UVMap').data.foreach_set('uv', loop_uv.ravel())
    p, q, r = (uv[idx[:, k]] for k in range(3))
    d1, d2 = q - p, r - p
    return {'charts': atlas.chart_count, 'fill': round(float(np.abs(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]).sum() / 2), 3)}


def principled(mat):
    node = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if node is None:
        raise RuntimeError(f'material {mat.name} has no Principled BSDF to bake from')
    return node


def emit_pass(dense, socket_name):
    # Cycles cannot bake an arbitrary BSDF input, so each pass reroutes what
    # feeds that input into an Emission shader and bakes EMIT. With no socket
    # it emits white, so the bake is a mask of the texels whose ray hit.
    restore = []
    for slot in dense.material_slots:
        mat = slot.material
        nt = mat.node_tree
        bsdf = principled(mat)
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
        old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].links else None
        emit = nt.nodes.new('ShaderNodeEmission')
        src = bsdf.inputs[socket_name] if socket_name else None
        if src is None:
            emit.inputs['Color'].default_value = (1, 1, 1, 1)
        elif src.links:
            nt.links.new(src.links[0].from_socket, emit.inputs['Color'])
        else:
            v = src.default_value
            emit.inputs['Color'].default_value = (v, v, v, 1) if isinstance(v, float) else tuple(v)
        nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
        restore.append((nt, out, old, emit))
    return restore


def unroute(restore):
    for nt, out, old, emit in restore:
        nt.nodes.remove(emit)
        if old is not None:
            nt.links.new(old, out.inputs['Surface'])


def bake(dense, low, image, cage, ray):
    mat = low.data.materials[0]
    nt = mat.node_tree
    for n in nt.nodes:
        n.select = False
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.select = True
    nt.nodes.active = tex
    bpy.ops.object.select_all(action='DESELECT')
    dense.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    b = bpy.context.scene.render.bake
    b.use_selected_to_active = True
    b.cage_extrusion = cage
    b.max_ray_distance = ray
    b.margin = 8
    b.margin_type = 'EXTEND'
    bpy.ops.object.bake(type='EMIT')
    nt.nodes.remove(tex)


def new_image(name, px, color):
    img = bpy.data.images.new(name, px, px, alpha=False)
    img.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    return img


def baked(dense, low, name, px, socket_name, cage, ray):
    img = new_image(name, px, socket_name is not None)
    restore = emit_pass(dense, socket_name)
    try:
        bake(dense, low, img, cage, ray)
    finally:
        unroute(restore)
    return img


def pixels(img):
    a = np.empty(len(img.pixels), np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def bake_tier(dense, low, px, cage, ray, far):
    # A ray longer than the gap between two dense surfaces (chin and throat)
    # bakes the far one's colour onto the near one; a short one misses where
    # the low surface sits far from the dense (flat chest). With `far`, texels
    # the short ray missed take the long ray's colour.
    size = max(dense.dimensions)
    cage = 0.03 * size if cage is None else cage
    ray = 0.08 * size if ray is None else ray
    mat = bpy.data.materials.new(f'{low.name}-mat')
    mat.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(mat)
    # Colour only: a creature's gloss is one flat roughness (tools/creatures/gloss.json), set at rig time.
    color = baked(dense, low, f'{low.name}-color', px, 'Base Color', cage, ray)
    missed = 0.0
    if far is not None:
        hit = pixels(baked(dense, low, f'{low.name}-hit', px, None, cage, ray))[:, :1] > 0.5
        far_hit = pixels(baked(dense, low, f'{low.name}-farhit', px, None, cage, far))[:, :1] > 0.5
        near, fallback = pixels(color), pixels(baked(dense, low, f'{low.name}-far', px, 'Base Color', cage, far))
        color.pixels.foreach_set(np.where(hit, near, fallback).ravel())
        missed = round(float((far_hit & ~hit).sum() / max(1, far_hit.sum())), 3)
    bsdf = principled(mat)
    col = mat.node_tree.nodes.new('ShaderNodeTexImage')
    col.image = color
    mat.node_tree.links.new(col.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 1.0
    color.pack()
    return missed


def set_normals(low, dense, mode):
    # A big collapsed face can tilt off the surface it stands for and light as
    # a bright streak (the brow-to-nose line on a person). `transfer` copies
    # the dense mesh's interpolated normals onto each corner, so the low mesh
    # shades like the dense one; `weighted` weights by face area; `angle:N`
    # splits edges sharper than N degrees.
    activate(low)
    if mode == 'transfer':
        mod = low.modifiers.new('dt', 'DATA_TRANSFER')
        mod.object = dense
        mod.use_loop_data = True
        mod.data_types_loops = {'CUSTOM_NORMAL'}
        mod.loop_mapping = 'POLYINTERP_NEAREST'
        bpy.ops.object.modifier_apply(modifier=mod.name)
    elif mode == 'weighted':
        mod = low.modifiers.new('wn', 'WEIGHTED_NORMAL')
        mod.mode = 'FACE_AREA'
        bpy.ops.object.modifier_apply(modifier=mod.name)
    elif mode.startswith('angle:'):
        bpy.ops.object.shade_smooth_by_angle(angle=np.radians(float(mode[6:])))


def export(low, path):
    activate(low)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_image_format='WEBP',
                              export_yup=True, export_apply=True, export_animations=False)


def main():
    a = args()
    focus = parse_focus(a.focus) if a.focus else None
    if not re.fullmatch(r'smooth|weighted|transfer|angle:[0-9.]+', a.normals):
        raise SystemExit(f'remesh: bad --normals "{a.normals}"; want smooth, weighted, transfer or angle:<deg>')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1

    t0 = time.time()
    dense = import_dense(a.src)
    dense_tris = sum(len(p.vertices) - 2 for p in dense.data.polygons)
    seals = {}

    def sealed_at(res):
        if res not in seals:
            t = time.time()
            sealed, info = seal(dense, res, a.min_part, a.close)
            s_open, s_nonman = topology(sealed)
            if s_open or s_nonman:
                raise RuntimeError(f'seal at {res} is not closed: {s_open} open, {s_nonman} non-manifold edges')
            print('remesh: ' + json.dumps({'stage': 'seal', 'denseTris': dense_tris, **info, 'seconds': round(time.time() - t, 1)}), flush=True)
            seals[res] = sealed
        return seals[res]

    # A finer seal keeps every real gap open but also every noise tunnel (fur,
    # spines), and collapse must keep both: it stalls above target or folds
    # surfaces through each other. Each tier takes the finest seal that
    # reaches its target cleanly (DESIGN §43).
    for tris in [int(t) for t in a.tiers.split(',')]:
        t1 = time.time()
        tried = []
        for res in [int(r) for r in a.seal_res.split(',')]:
            low = remesh_tier(sealed_at(res), tris, focus)
            open_edges, nonman = topology(low)
            if open_edges or nonman:
                raise RuntimeError(f'{tris}-tri tier from the {res} seal is not sealed: {open_edges} open, {nonman} non-manifold edges')
            got, crossings = len(low.data.polygons), self_intersections(low)
            tried.append({'res': res, 'tris': got, 'crossings': crossings})
            if abs(got - tris) <= 0.02 * tris and crossings <= a.max_crossings * tris:
                break
            bpy.data.meshes.remove(low.data)
        else:
            raise RuntimeError(f'no seal resolution gives a clean {tris}-tri tier: {tried}')
        # Collapse barely moves the bbox, so the share of faces in the slab over
        # the sealed surface's even-sized faces' share is the density gain there.
        gain = {'focusGain': round(focus_share(low, focus) / focus_share(sealed_at(res), focus), 2)} if focus else {}
        uv = unwrap(low, a.tex, a.padding)
        far_share = bake_tier(dense, low, a.tex, a.cage, a.ray, a.ray_far)
        far = {'farShare': far_share} if a.ray_far is not None else {}
        out = f'{a.out_prefix}-{tris}.glb'
        set_normals(low, dense, a.normals)
        export(low, out)
        print('remesh: ' + json.dumps({'stage': 'tier', 'targetTris': tris, 'tris': got, 'sealRes': res, 'selfIntersections': crossings,
                                        'tried': tried, **gain, **far,'tex': a.tex, **uv, 'file': out, 'seconds': round(time.time() - t1, 1)}), flush=True)
    print('remesh: ' + json.dumps({'stage': 'done', 'seconds': round(time.time() - t0, 1)}), flush=True)


if __name__ == '__main__':
    main()
