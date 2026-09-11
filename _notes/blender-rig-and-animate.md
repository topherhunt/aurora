# Blender: rig a creature and author its animations

Written against **Blender 5.2 LTS**. Where 5.x differs from the 4.x muscle memory, the difference is called out inline and collected in [What changed since Blender 4](#what-changed-since-blender-4) at the end.

The target is the `/gen-creature` bench: a `.glb` per clip in `tools/creatures/work/<id>/`, named `anim-<clip>.glb`. The bench globs those (`tools/creatures/workspace.mjs:415`) and plays `gltf.animations[0]` (`src/gen-creature-main.js:917`), so **one clip per file** is the only hard rule on the export side.

## Conventions

| Thing | Value | Why |
| --- | --- | --- |
| Up axis | +Z in Blender, +Y in glTF | The exporter converts. Don't pre-rotate the model. |
| Facing | \-Y in Blender, +Z in glTF | Blender's own convention; every addon assumes it. |
| Scale | 1 unit = 1 metre | A fox is ~0.7 long, a dragon a few metres. |
| Mesh origin | On the floor, centred in X and Z | The engine places creatures by their feet. `tools/characters/rig.mjs` positions `Hips` by a *fraction* of height, which only works if y=0 is the ground. |
| Bone names | Mixamo style, `LeftArm` not `Arm.L` | Single vocabulary for bipeds and quadrupeds both. See [Bone names](#bone-names). |

Two origins exist for a rigged character and they are not the same thing: the **armature object's** origin sits on the floor, while the `Hips` **bone** sits up at hip height. Don't try to make them agree.

---

## 1. Mesh prep

1. Import the `.glb` (`File > Import > glTF 2.0`).
2. Put the mesh on the floor and centred. Fastest route: `Object > Set Origin > Origin to Geometry` to get a predictable handle, then move the object so the lowest verts sit at z=0 and it straddles the world origin in X and Y, then `Object > Set Origin > Origin to 3D Cursor` with the cursor at the world origin (`Shift+C`, or `Shift+S > Cursor to World Origin`).
3. `Ctrl+A > All Transforms`**.** This bakes the object's loc/rot/scale into the vertex data and resets the object transform to identity. Do it before rigging, not after. A rig built on a scaled object produces animation that looks right in Blender and wrong everywhere else.
4. Clean the topology now, while nothing depends on it: Edit Mode, `A` to select all, `M > Merge by Distance`. Read the count it reports. This is also the fix for the bone-heat error in step 5, so doing it pre-emptively saves a round trip.

## 2. Build the armature

Armatures can only be added in **Object Mode** (`Add > Armature`). If the menu entry isn't there, you're in Edit or Pose mode on something else.

Immediately, before doing anything else, turn on two display options in **Object Data Properties** (the little green running-man tab) **> Viewport Display**:

- **In Front** -- draws bones over the mesh instead of buried inside it. Without this you are rigging blind.
- **Axes** -- draws the local axis cross on each bone. This is what makes [bone roll](#4-bone-roll) something you look at rather than guess at.

Then in **Edit Mode** on the armature:

1. The single default bone becomes `Hips`. Place it at the pelvis, **pointing forward along the body** (head at the pelvis, tail toward the ribcage), not vertical. Mixamo's `Hips` is the first link in the spine chain, so its tail is where `Spine` begins. Standing it upright works but makes every spine rotation feel rotated by 90 degrees forever after.
2. `E` extrudes a **connected** child from the selected bone's tail. That is how you build any unbranched run: `Hips` → `E` → `Spine` → `E` → `Spine1` → `E` → `Spine2` → `E` → `Neck` → `E` → `Head`.
3. For a child that starts somewhere its parent's tail *isn't* -- both shoulders, both `UpLeg`s, the tail -- extrude anyway and then `Alt+P > Disconnect Bone`, which keeps the parent relationship but frees the head to be moved. Then move it into place.
4. Build **only the centre line and the left side.** Name left bones `Thing.L` for now -- the `.L` suffix is what Symmetrize understands. They get renamed to Mixamo style in step 3.
5. Rename as you go with `F2`. Renaming 60 bones at the end is miserable and error-prone.

### Bone names

The tree Mixamo actually uses. Note that the legs hang straight off `Hips`, but the arms travel all the way up to `Spine2` -- asymmetric, but that's the standard, and anatomically it's pelvis versus ribcage.

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

Naming rules: side is a **prefix word** (`LeftArm`), the first of a chain carries **no number** (`Spine`, then `Spine1`), thigh is `UpLeg` and shin is `Leg`, upper arm is `Arm` and forearm is `ForeArm`.

**Quadrupeds use the same vocabulary, unchanged.** The front legs *are* the arm chain and the hind legs *are* the leg chain, which is anatomically honest: `Shoulder` is the scapula, `Hand` and `ToeBase` are paws, and `Foot` is the hock, just held vertical on a digitigrade animal. This is the whole point of picking Mixamo -- one convention, not two.

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

Reading these: a run joined by `─` is an unbranched chain, and anything with children of its own nests onto its own line. Only the unbranched runs are *connected* bones in Blender.

For wings, extend rather than invent: the wing is an arm, so `LeftHand` → `LeftHandFinger1`, `LeftHandFinger2`... for the membrane spars. Nothing retargets wings anyway, so the only requirement is that you can remember it in six months.

## 3. Mirror, then rename

**Mirror:** Edit Mode, select the left-side bones, `Armature > Symmetrize`. It reads the `.L` suffix, creates `.R` counterparts mirrored across X, and mirrors the roll correctly -- which is the part that's painful by hand.

Symmetrize mirrors across the armature's **local** X, so if the armature object itself is rotated, the mirror lands crooked. `Ctrl+A > All Transforms` on the armature in Object Mode first if you've rotated it at all.

**Then rename to Mixamo style.** Select all bones in Edit Mode and `Ctrl+F2` (Batch Rename). Set the operation to **Set Name > Find/Replace**, tick **Regular Expressions**, and run it twice:

| Find | Replace |
| --- | --- |
| `^(.*)\.L$` | `Left\1` |
| `^(.*)\.R$` | `Right\1` |

Symmetrize first, rename second. Symmetrize does not understand a `Left`/`Right` prefix, only the `.L`/`.R` suffix, so renaming first costs you the mirror.

## 4. Bone roll

Edit Mode, select all (`A`), `Armature > Bone Roll > Recalculate Roll`, shortcut `Shift+N`. (It was `Ctrl+N` in Blender 2.7x; `Ctrl+N` is New File now.)

The submenu's ~11 entries are three families, not eleven answers:

- **Global ±X/±Y/±Z Axis** -- point each bone's local Z as close to that world direction as its own axis allows. This is the family you want.
- **Local X/Z/-X/-Z Tangent** -- roll each bone from its neighbours in the chain, so a curve twists smoothly instead of popping. Genuinely better for a long tail or serpentine neck.
- **Active Bone / View Axis / Cursor** -- reference-based. `Active Bone` copies the active bone's roll to the rest, which is the fix when one bone in a chain is the odd one out.

**Default answer: select everything,** `Shift+N`**,** `Global +Z Axis`**.** Then, if it matters, select just the limb bones and redo with `Global -Y Axis`, which points their Z forward (Blender faces -Y) and gives knees and elbows a clean bend around local X.

The reason limbs want their own pass: `Global +Z` can do nothing for a bone that already points straight down, because the bone's own axis eats the direction you asked for. Blender doesn't error, it falls back to roll 0. That's consistent and deterministic and perfectly usable -- just not for the reason the menu name suggests.

What actually matters more than the choice:

- **Do it before skinning and before posing.** Roll changes the rest pose, so changing it after you've keyed a walk cycle invalidates every key.
- **Symmetrize after**, or at least verify left and right match. Roll asymmetry is what makes a mirrored pose look subtly broken.
- **Use the redo panel** (bottom-left of the viewport after the operator runs) to flip between options and watch the axis crosses, instead of reasoning about it.

For export correctness roll is irrelevant: glTF bakes rest transforms and stores animation relative to them, so any consistent roll round-trips identically. It buys authoring comfort and clean mirroring, nothing else.

## 5. Bind the mesh

Object Mode. **Select the mesh first, then** `Shift`**-select the armature** so the armature is active (light outline). Order matters -- it's parent-last.

`Object > Parent > Armature Deform > With Automatic Weights` (or `Ctrl+P` and pick it from the pie).

**Watch the status bar at the bottom of the screen.** A failure here is reported as a small transient message, and the parenting silently does not take. The common one:

> Bone heat weighting: failed to find solution for one or more bones

That means the mesh geometry defeated the heat solver -- usually duplicate verts, non-manifold edges, or interior geometry. Fix and retry:

1. Edit Mode on the mesh, `A`, `M > Merge by Distance`.
2. Still in Edit Mode, `Select > All by Trait > Non Manifold` to see what else is wrong.
3. Undo the failed parent (`Ctrl+Z`) before retrying, or you'll stack modifiers.

If it still refuses, `With Empty Groups` gets you a working parent with zero weights, and you paint everything by hand. Slow but never fails.

**Verify the bind before moving on.** Select the armature, `Ctrl+Tab` into Pose Mode, pick a limb bone, `R` and swing it. The mesh must follow. `Alt+R` clears the rotation afterwards. If nothing moves, the parent didn't take, regardless of what the Outliner shows.

### Fixing weights

Select the **mesh**, switch to **Weight Paint** mode. In the Properties editor's Object Data tab, the **Vertex Groups** list is one group per bone -- select the group for the bone you want to fix, and paint.

Faster in practice: in Weight Paint mode, `Ctrl`-click a bone in the viewport to make its group active, rather than hunting the list.

Useful settings: brush **Weight** 1.0 to add and 0.0 to subtract, **Auto Normalize** on (in the tool's Options) so the weights across all bones keep summing to 1, and **X Mirror** on (Options) so symmetric fixes only need painting once.

## 6. Animate

Switch to the **Animation** workspace tab along the top. Select the armature, `Ctrl+Tab` into **Pose Mode**.

### Stop yourself keying the mesh by accident

The mesh sits on top of the armature, so it is very easy to click the mesh, stay in Object Mode, and key *the mesh object's* location and scale. It looks like it worked. The diamonds appear. Nothing about the pose is saved, and you don't find out until much later. Two guardrails, both one-time setup:

1. **Make the mesh unselectable.** In the Outliner, click the **funnel icon** > under Restriction Toggles enable the **arrow/cursor** column, then click that arrow next to the mesh. Now clicking it in the viewport does nothing and the armature is the only thing you can grab. This is the fix that actually holds.
2. **Set the Keying Set to `Whole Character`** (below). It is defined over pose bones, so in the wrong mode it fails loudly with "Keying Set failed to insert any keyframes" instead of quietly keying the wrong thing.

The three-second pre-flight before any keying: header says **Pose Mode**, the Dope Sheet channel list shows **bone names** rather than the mesh's name, and the mouse is **over the 3D viewport**.

### Create the action

In the Dope Sheet header, switch the mode dropdown to **Action Editor**. Click **New**, name it something like `walk`.

Then click the **shield icon** (Fake User) next to the name. Without it, an action with no user is deleted when you save and reload, and you will lose work. This is the single most common way to lose a clip.

**Blender 5 note:** actions now have **Slots**, and the Action Editor header shows a slot selector next to the action name. For one armature and one clip this is invisible -- a slot is created and assigned automatically. It matters only if you deliberately put several objects' animation in one action, which you should not do here.

### Set up the loop

Set the frame range in the Timeline. **A clip of N frames needs a key at frame 1 and an identical key at frame N+1**, with the playback range set to 1..N. Frame N+1 is the same instant as frame 1 coming round again, so keying it makes the interpolation into the loop point correct; excluding it from the range stops it playing twice.

A 24-frame walk at 24 fps is one second per cycle and a sane starting point.

### Turn on Auto IK first

**Sidebar (`N`) > Tool tab > Pose Options > Auto IK.** Tick it. This is the one setting that makes posing bearable, and it is buried where you will never find it again.

With it on, `G`-grabbing a bone drags it while the parents *solve* to follow, instead of you rotating each joint and compensating in the next one down. Grab a foot, put it where you want it, and the shin and thigh work it out.

**While still dragging, PageUp / PageDown (or the scroll wheel) grows and shrinks the chain length** -- you decide live how far up the body the solve travels. Two or three bones is usually right for a leg; let it reach the spine and the whole creature lurches.

This is the scrappy version of a control rig: no pole vectors, no foot-orientation lock, no custom handles. It also **adds no bones**, so nothing about the export changes. Building the real thing (dedicated `IK_`/`POLE_` bones carrying Inverse Kinematics constraints) is only worth it if the lack of knee-direction control starts costing real time.

> **Keying follows selection, and Auto IK doesn't.** You select the foot and drag it, but the solver puts the rotation into the *parents*, which aren't selected -- so a selection-scoped key captures nothing useful. You find out when you scrub away and the pose is gone. Longstanding and closed as expected behaviour ([#27926](https://projects.blender.org/blender/blender/issues/27926), [#54946](https://developer.blender.org/T54946)).
>
> **The fix is the `Whole Character` Keying Set** (see [Key poses](#key-poses)), which keys every bone regardless of selection. Set it once and the problem is gone permanently.

One 5.x quirk: a bone's IK rotation-limit fields in Bone Properties look greyed out when it has no IK constraint, but they still affect Auto IK ([bug #157731](https://projects.blender.org/blender/blender/issues/157731)). If a joint bends somewhere impossible, check those limits even though the UI implies they're inert.

### Key poses

**Hotkeys go to whichever editor the mouse is hovering over.** Press `I` with the pointer over the Timeline and nothing happens at all: no key, no error, no feedback. Keyframe hotkeys need the mouse **over the 3D viewport**.

**Set the active Keying Set to `Whole Character` before you key anything.** Timeline header dropdown, or `Shift+K`. This is the setting that makes the whole thing work: `I` then keys **every bone in the rig regardless of selection**, so Auto IK's unselected parents get captured and selection stops being something you manage. Extra channels cost nothing at this scale and the exporter samples everything anyway. It also fails loudly in the wrong mode rather than keying the mesh.

- `I` inserts a keyframe. **Since Blender 4.1 it no longer opens a menu** -- it keys the active Keying Set, or failing that the channels listed under `Edit > Preferences > Animation > Keyframes > Default Key Channels`.
- `K` opens the old pick-a-channel menu when you want it. `Shift+K` changes the active Keying Set.
- `Alt+G` / `Alt+R` / `Alt+S` clear a bone's location / rotation / scale back to rest.

**The loop: pose with Auto IK, press `I`, move to the next frame.** Mouse over the viewport throughout.

**"Channels" is the left-hand column of the Dope Sheet**: one expandable row per bone, with `X Location`, `W Quaternion Rotation` and so on underneath. The **Timeline has no channel column** -- it's a deliberately stripped-down Dope Sheet, one row of diamonds and a playhead. If you're in the Layout workspace hunting for channels, that's why there aren't any. Use the **Animation** workspace tab.

Watch out for the Dope Sheet's **"Only Show Selected"** filter (the cursor-arrow icon in its header), **on by default**. Deselect a bone and its channels vanish from the list even though the keys are still there. Turn it off while you're learning.

Block out **extremes first**, then fill in. For a walk that's four poses per half-cycle: contact, down, passing, up.

### Mirror the second half

Pose the first half of the cycle, then for the second half:

1. Select all bones (`A`), `Ctrl+C` (Pose > Copy Pose) on the pose you want mirrored.
2. Jump to the frame half a cycle later, `Ctrl+Shift+V` (Pose > Paste Pose Flipped).

This is why the `Left`/`Right` naming has to be exactly right. Paste-flipped works by string-swapping bone names, so a typo means a bone that doesn't mirror, and it fails quietly.

### Smooth it

**You don't need the Graph Editor for this.** In the **Dope Sheet**, select the keys you want (`A` for all) and press `T` for **Key > Interpolation Mode**: **Bezier** for organic motion, **Linear** for mechanical, **Constant** for snaps. Same operator, same hotkey, no editor switching.

Reach for the Graph Editor only when you want to see and drag the actual curve -- easing a specific joint, killing an overshoot. **There is no Graph Editor workspace tab.** Every editor's header starts with an **Editor Type dropdown** (the leftmost icon, top-left corner of that editor); click it and pick **Graph Editor** under Animation. The usual move is to switch the Animation workspace's Dope Sheet over, look, then switch back. Right-click an area border > **Vertical Split** if you want both at once.

For a cycle that has to keep going while you scrub past the end, add `Channel > Extrapolation Mode > Make Cyclic (F-Modifier)`. This one *is* Graph Editor only. It's a **preview aid** -- bake or remove it before export, since the exporter samples what it sees.

### Test it

Spacebar plays. Watch for the two things that read as "wrong" instantly:

- **Foot sliding.** The planted foot must not move in world space while it's on the ground. Easiest check: turn on the bone's motion path (`Pose > Motion Paths > Calculate`) and look for a flat segment.
- **Popping at the loop point.** Play across the boundary repeatedly. If it hitches, frame 1 and frame N+1 aren't identical.

**Keep the character in place.** No root motion -- the engine drives world position. The `Hips` can bob and sway, but it should not travel.

## 7. Export to the bench

`File > Export > glTF 2.0 (.glb)`.

| Setting | Value |
| --- | --- |
| Format | **glTF Binary (.glb)** |
| Include > Limit to | **Selected Objects**, with mesh *and* armature selected |
| Transform | **+Y Up** (default, leave it) |
| Data > Mesh | Apply Modifiers on |
| Data > Armature > Export Deformation Bones Only | **Off** while every bone deforms. Turn it on only once you add control or IK bones that shouldn't ship. |
| Animation > Animation Mode | **Active actions merged** -- exports just the currently assigned action, guaranteeing one clip |
| Animation > Limit to Playback Range | On, so the loop exports as 1..N |

Save as `tools/creatures/work/<id>/anim-<clip>.glb`, e.g. `anim-walk.glb`. Reload the bench and the clip appears in the dropdown; no code change needed, the workspace globs `anim-*.glb`.

**One clip per file.** If a file ends up with several, the bench plays the first and silently ignores the rest -- not fatal, just confusing. If you'd rather leave Animation Mode on the default **Actions**, be aware it exports every action that has a user (which, once you've ticked Fake User on each, means all of them).

The skeleton travels **inside the same GLB**, because the bench loads each file standalone. Do not export back over `rig.glb` (a paid Tripo artifact) or `rig-fixed.glb` (regenerated from `rig.glb` + `rig-edit.json` every time the rig editor saves).

---

## What changed since Blender 4

Relevant to this workflow only:

- **Insert Keyframe stopped being a menu (4.1).** `I` now keys the active Keying Set or the Default Key Channels preference. `K` is the old menu, `Shift+K` picks the Keying Set. This is the change most likely to make old tutorials confusing.
- **Slotted Actions (4.4), legacy API removed (5.0).** An Action holds one or more Slots, each a separate bag of F-Curves, so one Action can animate several things. The Action Editor gained a slot selector; 5.0 made it show the slot's type. Old files upgrade automatically, each action getting a "Legacy Slot". For one-armature-one-clip it's invisible. glTF exports a multi-slot action as a single animation by default.
- **Bone visibility and selection moved onto the pose bone (5.0)**, so instanced armatures no longer share hide/select state.
- **Deleting a bone now removes its constraints on leaving Edit Mode, and drivers survive a bone rename (5.1).** Both are straight bug fixes in your favour.
- **Theme and icon overhaul (5.0).** Cosmetic. 4.5 custom themes do not carry over.
- **Bone Collections** (since 4.0) replaced the old bone layers, and can now nest. Not needed at this rig's size, but that's where a tutorial's "move it to layer 2" instruction went.

Blender 5.2's headline features -- the XPBD physics solver, EEVEE screen-space raytracing, remote asset libraries, the Grease Pencil fill algorithm -- touch none of this.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Pressed `I`, absolutely nothing happened | Mouse wasn't over the 3D viewport. Hotkeys go to the editor under the cursor. |
| Keyed a pose but the Dope Sheet is empty | Either no bones were selected when you keyed, or "Only Show Selected" is hiding deselected bones. |
| Dragging a bone rotates it instead of solving the chain | Auto IK is off. Sidebar (`N`) > Tool > Pose Options > Auto IK. |
| Posed a leg with Auto IK, but only one bone got keyed | Keying follows selection; Auto IK moves the unselected parents. Set the Keying Set to `Whole Character`. |
| Keys exist, diamonds show, but scrubbing moves nothing | Armature set to Rest Position (Object Data Properties > Skeleton), or the action has no slot assigned (Action Editor header, next to the name). |
| Mesh doesn't follow bones in Pose Mode | Parenting failed. Check the status bar message, fix geometry, re-parent. |
| "Bone heat weighting: failed to find solution" | Duplicate or non-manifold geometry. `M > Merge by Distance` first. |
| Animation right in Blender, wrong in the bench | Unapplied object transform. `Ctrl+A > All Transforms` before rigging, not after. |
| Paste Pose Flipped does nothing to some bones | Name typo. Flipping is a string swap on `Left`/`Right`. |
| Clip vanished after save and reload | No Fake User on the action. |
| Loop hitches | Frame 1 and frame N+1 aren't identical, or the playback range includes N+1. |
| Symmetrize mirrored crooked | Armature object has an unapplied rotation. |
| Recalculate Roll seems to do nothing on the legs | Expected. Vertical bones are degenerate for `Global +Z`; it falls back to roll 0. Use `Global -Y Axis` for limbs. |

## Sources

Blender 5.x behaviour above was checked against the official docs; specific exporter option wording in 5.2 is the least-verified part of this note.

- [Blender 5.0 Release Notes](https://developer.blender.org/docs/release_notes/5.0/)
- [Animation & Rigging -- Blender 5.0](https://developer.blender.org/docs/release_notes/5.0/animation_rigging/)
- [Blender 5.1: Animation & Rigging](https://developer.blender.org/docs/release_notes/5.1/animation_rigging/)
- [Blender 5.2 LTS Release Notes](https://developer.blender.org/docs/release_notes/5.2/)
- [Slotted Actions (4.4)](https://developer.blender.org/docs/release_notes/4.4/animation_rigging/)
- [Bone Roll -- Blender 5.2 LTS Manual](https://docs.blender.org/manual/en/latest/animation/armatures/bones/editing/bone_roll.html)
- [Editing Keyframes -- Blender 5.2 LTS Manual](https://docs.blender.org/manual/en/latest/animation/keyframes/editing.html)
- [Bone Collections -- Blender 5.2 LTS Manual](https://docs.blender.org/manual/en/latest/animation/armatures/bones/bone_collections.html)
- [glTF 2.0 -- Blender 5.2 LTS Manual](https://docs.blender.org/manual/en/latest/addons/scene_gltf2.html)
- [Everything New in Blender 4.1 (CG Cookie)](https://cgcookie.com/posts/everything-new-in-blender-4-1)
