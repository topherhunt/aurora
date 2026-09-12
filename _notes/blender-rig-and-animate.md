# Blender: rig a creature and author its animations

Written against **Blender 5.2 LTS**; 5.x-vs-4.x differences are flagged inline and listed at the end.

Target is the `/gen-creature` bench: one `.glb` per clip in `tools/creatures/work/<id>/`, named `anim-<clip>.glb`. The bench globs those (`tools/creatures/workspace.mjs:415`) and plays `gltf.animations[0]` (`src/gen-creature-main.js:917`), so **one clip per file** is the only hard export rule.

## Conventions

| Thing | Value | Why |
| --- | --- | --- |
| Up axis | +Z in Blender, +Y in glTF | The exporter converts. Don't pre-rotate. |
| Facing | \-Y in Blender, +Z in glTF | Blender's convention; every addon assumes it. |
| Scale | 1 unit = 1 metre | A fox is ~0.7 long, a dragon a few metres. |
| Mesh origin | On the floor, centred in X and Z | `tools/characters/rig.mjs` positions `Hips` by a *fraction* of height, which only works if y=0 is the ground. |
| Bone names | Mixamo style, `LeftArm` not `Arm.L` | One vocabulary for bipeds and quadrupeds both. |

The **armature object's** origin sits on the floor; the `Hips` **bone** sits at hip height. Two different things -- don't make them agree.

---

## 1. Mesh prep

1. `File > Import > glTF 2.0`.
2. Floor it and centre it: `Object > Set Origin > Origin to Geometry` for a predictable handle, move the object so the lowest verts sit at z=0 and it straddles the origin in X/Y, then `Set Origin > Origin to 3D Cursor` with the cursor at the world origin (`Shift+C`).
3. **`Ctrl+A > All Transforms`.** Bakes loc/rot/scale into the vertices. Before rigging, not after -- a rig built on a scaled object looks right in Blender and wrong everywhere else.
4. Edit Mode, `A`, **`M > Merge by Distance`**. Also pre-empts the bone-heat failure in step 5.

## 2. Build the armature

Armatures can only be added in **Object Mode** (`Add > Armature`). Then, in **Object Data Properties** (green running-man tab) **> Viewport Display**, turn on:

- **In Front** -- draws bones over the mesh. Without it you're rigging blind.
- **Axes** -- draws each bone's local axis cross, which makes [bone roll](#4-bone-roll) visible rather than guesswork.

In **Edit Mode**:

1. The default bone becomes `Hips`. Put it at the pelvis **pointing forward along the body** (tail toward the ribcage), not vertical -- it's the first link in the spine chain, so its tail is where `Spine` starts. Upright works but leaves every spine rotation feeling 90 degrees off forever.
2. `E` extrudes a **connected** child from the tail. That builds any unbranched run: `Hips` → `Spine` → `Spine1` → `Spine2` → `Neck` → `Head`.
3. For a child starting where its parent's tail *isn't* (both shoulders, both `UpLeg`s, the tail): extrude, then `Alt+P > Disconnect Bone`, then move the head into place.
4. Build **only the centre line and the left side**, naming left bones `Thing.L` -- that suffix is what Symmetrize reads. They get Mixamo names in step 3.
5. Rename as you go with `F2`.

### Bone names

Legs hang straight off `Hips`, but the arms travel all the way up to `Spine2`. Asymmetric, but that's the standard -- pelvis versus ribcage.

```
Hips
├─ Spine
│  └─ Spine1
│     └─ Spine2
│        ├─ Neck ─ Head ─ HeadTop_End
│        ├─ LeftShoulder  ─ LeftArm  ─ LeftForeArm  ─ LeftHand  ─ fingers
│        └─ RightShoulder ─ RightArm ─ RightForeArm ─ RightHand ─ fingers
├─ LeftUpLeg  ─ LeftLeg  ─ LeftFoot  ─ LeftToeBase  ─ LeftToe_End
└─ RightUpLeg ─ RightLeg ─ RightFoot ─ RightToeBase ─ RightToe_End
```

Rules: side is a **prefix word** (`LeftArm`); the first of a chain carries **no number** (`Spine`, then `Spine1`); thigh is `UpLeg`, shin is `Leg`, upper arm is `Arm`, forearm is `ForeArm`.

**Quadrupeds use the same vocabulary unchanged.** Front legs *are* the arm chain, hind legs *are* the leg chain -- anatomically honest, since `Shoulder` is the scapula, `Hand`/`ToeBase` are paws, and `Foot` is the hock held vertical on a digitigrade animal.

```
Hips
├─ Spine
│  └─ Spine1
│     └─ Spine2
│        ├─ Neck
│        │  └─ Neck1               only if the neck is long
│        │     └─ Head
│        │        ├─ LeftEar ─ LeftEar1
│        │        ├─ RightEar ─ RightEar1
│        │        └─ Jaw
│        ├─ LeftShoulder  ─ LeftArm  ─ LeftForeArm  ─ LeftHand
│        └─ RightShoulder ─ RightArm ─ RightForeArm ─ RightHand
├─ LeftUpLeg  ─ LeftLeg  ─ LeftFoot  ─ LeftToeBase
├─ RightUpLeg ─ RightLeg ─ RightFoot ─ RightToeBase
└─ Tail ─ Tail1 ─ Tail2 ─ Tail3
```

Reading these: a run joined by `─` is an unbranched chain; anything with children of its own nests onto its own line. Only the unbranched runs are *connected* bones.

Wings extend the arm: `LeftHand` → `LeftHandFinger1`, `LeftHandFinger2`... for the membrane spars.

## 3. Mirror, then rename

**Symmetrize first.** Edit Mode, select the left bones, `Armature > Symmetrize`. It reads the `.L` suffix, mirrors across X, and gets the roll right -- the part that's painful by hand. It mirrors across the armature's **local** X, so `Ctrl+A > All Transforms` on the armature first if you've rotated it.

**Then batch-rename.** Select all bones, `Ctrl+F2`, operation **Set Name > Find/Replace**, tick **Regular Expressions**, run twice:

| Find | Replace |
| --- | --- |
| `^(.*)\.L$` | `Left\1` |
| `^(.*)\.R$` | `Right\1` |

Order matters: Symmetrize understands only the `.L`/`.R` suffix, so renaming first costs you the mirror.

## 4. Bone roll

Edit Mode, `A`, `Armature > Bone Roll > Recalculate Roll`, shortcut **`Shift+N`** (it was `Ctrl+N` in 2.7x; that's New File now).

The ~11 entries are three families:

- **Global ±X/±Y/±Z Axis** -- point each bone's local Z as near that world direction as its own axis allows. The family you want.
- **Local X/Z/-X/-Z Tangent** -- roll from chain neighbours, so a curve twists smoothly. Better for a long tail or serpentine neck.
- **Active Bone / View Axis / Cursor** -- reference-based. `Active Bone` fixes the one bone in a chain that's the odd one out.

**Default: select all, `Shift+N`, `Global +Z Axis`.** Then optionally select just the limbs and redo with `Global -Y Axis`, pointing their Z forward so knees and elbows bend cleanly around local X. That second pass exists because `Global +Z` can do nothing for an already-vertical bone -- the bone's own axis eats the direction, and Blender silently falls back to roll 0. Consistent and usable, just not what the menu name implies.

More important than the choice:

- **Do it before skinning and posing.** Roll changes the rest pose, invalidating existing keys.
- **Symmetrize after**, or verify L/R match. Roll asymmetry is what makes mirrored poses look subtly broken.
- **Use the redo panel** (bottom-left after the operator runs) to flip options and watch the axis crosses.

For export, roll is irrelevant -- glTF bakes rest transforms and stores animation relative to them. It buys authoring comfort and clean mirroring, nothing else.

## 5. Bind the mesh

Object Mode. **Select the mesh first, then `Shift`-select the armature** so the armature is active. Then `Object > Parent > Armature Deform > With Automatic Weights` (or `Ctrl+P`).

**Watch the status bar.** Failure is a small transient message and the parenting silently doesn't take. The usual one:

> Bone heat weighting: failed to find solution for one or more bones

Geometry defeated the heat solver -- duplicate verts, non-manifold edges, interior geometry. `Ctrl+Z` the failed parent (or you'll stack modifiers), then Edit Mode, `A`, `M > Merge by Distance`, and `Select > All by Trait > Non Manifold` to see what else is wrong. If it still refuses, `With Empty Groups` always works and leaves you painting everything by hand.

**Verify before moving on:** `Ctrl+Tab` into Pose Mode, pick a limb bone, `R` and swing it. The mesh must follow; `Alt+R` to clear. If nothing moves the parent didn't take, whatever the Outliner shows.

### Fixing weights

Select the **mesh**, switch to **Weight Paint**. `Ctrl`-click a bone in the viewport to make its vertex group active (faster than hunting the Vertex Groups list), then paint: brush **Weight** 1.0 adds, 0.0 subtracts. In Options, turn on **Auto Normalize** (weights keep summing to 1) and **X Mirror** (symmetric fixes painted once).

## 6. Animate

**Animation** workspace tab. Select the armature, `Ctrl+Tab` into **Pose Mode**.

### Two guardrails, set once

The mesh sits on top of the armature, so it's easy to click the mesh, stay in Object Mode, and key *the mesh object's* location and scale. It looks like it worked -- diamonds appear, nothing about the pose is saved, and you find out much later.

1. **Make the mesh unselectable.** Outliner > **funnel icon** > under Restriction Toggles enable the **arrow/cursor** column, then click that arrow beside the mesh. Now the armature is the only thing you can grab. This is the fix that holds.
2. **Set the Keying Set to `Whole Character`.** Timeline header dropdown, or `Shift+K`. `I` then keys **every bone regardless of selection**, so Auto IK's unselected parents get captured and selection stops mattering. It's defined over pose bones, so in the wrong mode it fails loudly ("Keying Set failed to insert any keyframes") instead of quietly keying the mesh. Extra channels cost nothing here and the exporter samples everything anyway.

Pre-flight: header says **Pose Mode**, the Dope Sheet channel list shows **bone names**, mouse is **over the 3D viewport**.

### Create the action

Dope Sheet header > mode dropdown > **Action Editor** > **New**, name it `walk`. Then click the **shield icon** (Fake User) -- an action with no user is deleted on save-and-reload, and that's the most common way to lose a clip.

**Blender 5 slots.** An Action is the *animation*; a Slot is *which data-block it drives*. So the slot name stays the **same in every action** -- it's the armature object's name, not the clip's. Blender auto-assigns a slot on action switch by matching its identifier (a type prefix plus the name, e.g. `OBfen-dragon`) against the last-used one, so inconsistent slot names leave the slot unassigned and **the action plays nothing**.

Imported rigs inherit junk names like `Tripo Node <uuid>`. Rename the **armature object** in the Outliner to the creature id, then check each action's slot matches. Object names become node names in the exported GLB, so this is worth doing anyway.

| Layer | Name |
| --- | --- |
| Armature object | `fen-dragon` |
| Slot | `fen-dragon` -- identical in every action |
| Action | `walk`, `idle`, `run` |
| Export file | `anim-walk.glb` |

### Set up the loop

**A clip of N frames needs a key at frame 1 and an identical key at frame N+1**, with the playback range set to 1..N. Frame N+1 is frame 1 coming round again, so keying it makes interpolation into the loop point correct, while keeping it out of the range stops it playing twice. A 24-frame walk at 24 fps is one second per cycle.

Don't start from the rest pose. Frame 1 should be a contact pose; a rest frame in the cycle reads as a lurch.

### Auto IK

**Sidebar (`N`) > Tool tab > Pose Options > Auto IK.** Tick it. This is the setting that makes posing bearable, and it is buried where you will never find it again.

`G`-grabbing a bone now drags it while the parents *solve* to follow, instead of you rotating each joint and compensating in the next. **While dragging, PageUp/PageDown or the scroll wheel grows and shrinks the chain length** -- two or three bones for a leg; let it reach the spine and the whole creature lurches.

This is the scrappy version of a control rig: no pole vectors, no foot-orientation lock. It **adds no bones**, so nothing about export changes. Dedicated `IK_`/`POLE_` bones with Inverse Kinematics constraints are only worth building if the lack of knee-direction control starts costing real time.

Two traps:

- **Keying follows selection, and Auto IK doesn't.** You grab the foot, but the solver rotates the *unselected* parents, so a selection-scoped key captures nothing useful. Fixed permanently by the `Whole Character` Keying Set above. Longstanding, closed as expected behaviour ([#27926](https://projects.blender.org/blender/blender/issues/27926), [#54946](https://developer.blender.org/T54946)).
- A bone's IK rotation-limit fields look greyed out without an IK constraint but **still affect Auto IK** ([#157731](https://projects.blender.org/blender/blender/issues/157731)). If a joint bends somewhere impossible, check them anyway.

### Key poses

**Hotkeys go to whichever editor the mouse is over.** Press `I` over the Timeline and nothing happens -- no key, no error, no feedback. Keyframe hotkeys need the mouse **over the 3D viewport**.

- `I` inserts a keyframe. **Since 4.1 it no longer opens a menu**; it keys the active Keying Set, falling back to `Preferences > Animation > Keyframes > Default Key Channels`.
- `K` opens the old pick-a-channel menu. `Shift+K` changes the Keying Set.
- `Alt+G` / `Alt+R` / `Alt+S` clear a bone's location / rotation / scale to rest.

**The loop: pose with Auto IK, press `I`, move to the next frame.**

**"Channels" is the left column of the Dope Sheet** -- one expandable row per bone with `X Location`, `W Quaternion Rotation` underneath. The **Timeline has no channel column**; it's a stripped-down Dope Sheet, one row of diamonds and a playhead. If you're in the Layout workspace hunting for channels, that's why there aren't any.

Beware the Dope Sheet's **"Only Show Selected"** filter (cursor-arrow icon in its header), **on by default** -- deselect a bone and its channels vanish though the keys remain.

Block out **extremes first**: contact, down, passing, up.

### Retime and move keys

All in the Dope Sheet, and this is where an awkward gap gets fixed.

- **Move a whole pose.** The top **Summary** row collapses every channel into one line; click its diamond at that frame to select the entire column, then `G`, type an offset (`-3` `Enter` moves it three frames earlier), or drag with `Ctrl` held to snap to whole frames. If there's no Summary row, enable it under the funnel icon.
- **Select a column by hand** with `B` box-select dragged vertically through all channels at that frame.
- **Retime the whole clip** with `S`, which scales selected keys around the **current frame** -- park the playhead on frame 1 first or everything shifts.
- `X` deletes selected keys. `Shift+D` duplicates them, then move and click to place.

Moving keys never changes the pose, only when it happens, so this is always safe to experiment with.

### Mirror the second half

1. Select all bones (`A`), `Ctrl+C` (Pose > Copy Pose).
2. Jump half a cycle later, `Ctrl+Shift+V` (Pose > Paste Pose Flipped), then `I` to key it.

Paste Pose Flipped **sets the pose but does not key it** -- press `I` or it's gone when you scrub away. It also works by string-swapping `Left`/`Right` in bone names, so a naming typo means a bone that silently doesn't mirror.

### Smooth it

**You don't need the Graph Editor.** In the **Dope Sheet**, select keys (`A` for all) and press `T` for **Key > Interpolation Mode**: **Bezier** for organic, **Linear** for mechanical, **Constant** for snaps.

Reach for the Graph Editor only to see and drag actual curves. **There is no Graph Editor workspace tab** -- use the **Editor Type dropdown** (leftmost icon in any editor's header) and pick it under Animation, usually by flipping the Dope Sheet over and back.

`Channel > Extrapolation Mode > Make Cyclic (F-Modifier)` keeps a cycle going as you scrub past the end. Graph Editor only, and a **preview aid** -- remove it before export, since the exporter samples what it sees.

### Test it

Spacebar plays. The two things that read as wrong instantly:

- **Foot sliding.** A planted foot must not move in world space. Check with `Pose > Motion Paths > Calculate` and look for a flat segment.
- **Loop popping.** Play across the boundary repeatedly; a hitch means frames 1 and N+1 differ.

**Keep the character in place** -- no root motion, the engine drives world position. `Hips` can bob and sway but must not travel.

## 7. Export to the bench

`File > Export > glTF 2.0 (.glb)`.

| Setting | Value |
| --- | --- |
| Format | **glTF Binary (.glb)** |
| Include > Limit to | **Selected Objects**, mesh *and* armature selected |
| Transform | **+Y Up** (default) |
| Data > Mesh | Apply Modifiers on |
| Data > Armature > Export Deformation Bones Only | **Off** while every bone deforms; on once you add control bones |
| Animation > Animation Mode | **Active actions merged** -- exports only the assigned action, guaranteeing one clip |
| Animation > Limit to Playback Range | On, so the loop exports as 1..N |

Save as `tools/creatures/work/<id>/anim-<clip>.glb`. Reload the bench and it appears in the dropdown; no code change needed.

**One clip per file** -- extra clips aren't fatal, the bench just plays the first and ignores the rest. The default **Actions** mode exports every action with a user, which once you've ticked Fake User means all of them.

The skeleton travels **inside the same GLB**, since the bench loads each file standalone. Never export over `rig.glb` (a paid Tripo artifact) or `rig-fixed.glb` (regenerated from `rig.glb` + `rig-edit.json` on every rig-edit save).

---

## What changed since Blender 4

- **Insert Keyframe stopped being a menu (4.1).** `I` keys the active Keying Set or Default Key Channels; `K` is the old menu. Most likely thing to make an older tutorial confusing.
- **Slotted Actions (4.4), legacy API removed (5.0).** An Action holds Slots, each a separate bag of F-Curves, so one Action can animate several things. Old files upgrade automatically with a "Legacy Slot". glTF exports a multi-slot action as one animation.
- **Bone visibility and selection moved onto the pose bone (5.0)** -- instanced armatures no longer share hide/select state.
- **Deleting a bone removes its constraints; drivers survive a bone rename (5.1).**
- **Bone Collections** (4.0) replaced bone layers and can now nest -- that's where a tutorial's "move it to layer 2" went.
- **Theme and icon overhaul (5.0)** is cosmetic; 4.5 custom themes don't carry over.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Pressed `I`, nothing at all happened | Mouse wasn't over the 3D viewport. |
| Keyed a pose but the Dope Sheet is empty | Nothing selected when you keyed, or "Only Show Selected" is hiding it. |
| Keys exist, diamonds show, but scrubbing moves nothing | Armature set to Rest Position (Object Data Properties > Skeleton), or the action's slot is unassigned -- usually a slot-name mismatch between actions. |
| Posed with Auto IK, only one bone got keyed | Keying follows selection. Set the Keying Set to `Whole Character`. |
| Dragging a bone rotates instead of solving the chain | Auto IK is off. |
| Mesh doesn't follow bones in Pose Mode | Parenting failed; check the status bar, fix geometry, re-parent. |
| "Bone heat weighting: failed to find solution" | Duplicate or non-manifold geometry. `M > Merge by Distance`. |
| Animation right in Blender, wrong in the bench | Unapplied object transform. `Ctrl+A > All Transforms` before rigging. |
| Paste Pose Flipped does nothing / doesn't stick | Name typo (it string-swaps `Left`/`Right`), or you forgot to press `I`. |
| Clip vanished after save and reload | No Fake User on the action. |
| Loop hitches | Frames 1 and N+1 differ, or the range includes N+1. |
| Symmetrize mirrored crooked | Armature object has an unapplied rotation. |
| Recalculate Roll does nothing on the legs | Expected: vertical bones are degenerate for `Global +Z`. Use `Global -Y Axis` for limbs. |

## Sources

Checked against the official docs. Exporter option wording in 5.2 is the least-verified part.

[5.0 notes](https://developer.blender.org/docs/release_notes/5.0/) · [5.0 anim/rigging](https://developer.blender.org/docs/release_notes/5.0/animation_rigging/) · [5.1 anim/rigging](https://developer.blender.org/docs/release_notes/5.1/animation_rigging/) · [5.2 notes](https://developer.blender.org/docs/release_notes/5.2/) · [Slotted Actions](https://developer.blender.org/docs/release_notes/4.4/animation_rigging/) · [Bone Roll](https://docs.blender.org/manual/en/latest/animation/armatures/bones/editing/bone_roll.html) · [Editing Keyframes](https://docs.blender.org/manual/en/latest/animation/keyframes/editing.html) · [glTF 2.0](https://docs.blender.org/manual/en/latest/addons/scene_gltf2.html) · [What's new in 4.1](https://cgcookie.com/posts/everything-new-in-blender-4-1)
