"""Turn a Tripo rig GLB into a .blend that is ready to animate.

    blender --background --factory-startup --python tools/creatures/blend-rig.py -- \
        --in tools/creatures/work/<id>/rig.glb \
        --out tools/creatures/work/<id>/rig.blend

Three fixes, none of which survive a GLB round trip, which is the whole reason
this file exists rather than a step that rewrites the rig itself:

    connect coincident bones
        Auto IK only engages on a bone CONNECTED to its parent. Tripo ships
        every joint parented but loose, so `G` translates the bone and the
        solver never runs. Connecting is free wherever the child's head already
        sits on the parent's tail, which on a Tripo rig is most links; the rest
        are branch points, where one parent has several children and its tail
        can only aim at one of them. Those stay loose -- snapping them would
        move the joint and shift the bind -- and that costs nothing, because a
        branch point is a limb root, exactly where an IK chain should stop.

    hide the custom bone shapes
        Tripo assigns every pose bone an icosphere widget, so the armature draws
        as a cloud of balls in Object and Pose mode and as normal bones in Edit
        mode, which only ignores custom shapes. The widget itself is left alone:
        it sits in `glTF_not_exported`, so it never comes back out.

    switch Auto IK on

`use_connect` is a Blender authoring flag with no glTF representation, so none
of this can be baked into the GLB -- a .blend is the only artifact that holds it.
"""

import sys

import bpy

# Head-to-parent-tail distance under which a link counts as already coincident,
# in metres. Connecting across a gap wider than this would MOVE the joint, and
# the rest pose is what the mesh is bound against.
TOL = 1e-4


def script_args():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def arg(name, args):
    if name not in args:
        raise SystemExit(f"blend-rig: missing required argument {name}")
    return args[args.index(name) + 1]


def the_armature():
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    if len(arms) != 1:
        raise SystemExit(f"blend-rig: expected exactly one armature, found {len(arms)}: {[o.name for o in arms]}")
    return arms[0]


def connect_coincident(ob):
    """Set `use_connect` on every link whose child head already touches the
    parent's tail. Returns (connected, left_loose) name lists."""
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    connected, loose = [], []
    for eb in ob.data.edit_bones:
        if not eb.parent:
            continue
        if (eb.head - eb.parent.tail).length < TOL:
            eb.use_connect = True
            connected.append(eb.name)
        else:
            loose.append(eb.name)
    bpy.ops.object.mode_set(mode="OBJECT")
    return connected, loose


def main():
    args = script_args()
    src, dst = arg("--in", args), arg("--out", args)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    ob = the_armature()
    rest = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in ob.data.bones}

    connected, loose = connect_coincident(ob)
    ob.data.show_bone_custom_shapes = False
    ob.pose.use_auto_ik = True

    # The bind is only safe if the rest pose did not move. Assert it rather than
    # trust TOL: a silently shifted joint shows up later as a skinning artifact,
    # long after anyone would connect it back to this step.
    moved = max(
        (max((b.head_local - rest[b.name][0]).length, (b.tail_local - rest[b.name][1]).length)
         for b in ob.data.bones),
        default=0.0,
    )
    if moved > TOL:
        raise SystemExit(f"blend-rig: connecting moved the rest pose by {moved:.2e} m -- refusing to write {dst}")

    bpy.ops.wm.save_as_mainfile(filepath=dst)
    print(f"blend-rig: {len(connected)} connected, {len(loose)} left loose (branch points), rest pose moved {moved:.1e} m")
    print(f"blend-rig: loose -> {' '.join(loose) if loose else '(none)'}")


main()
