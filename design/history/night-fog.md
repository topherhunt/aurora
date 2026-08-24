# Heavy night fog -- retracted

**Not in the tree.** `fogDensity` at full dark is 0.00032, not 0.0022. Current behaviour is in `design/08-lighting.md`, "Night fog and the far field".

The argument below was the justification for a night `fogDensity` of 0.0022 toward `0x080b14`. It shipped, produced "all terrain at night is pitch-black except the mountains within ~500 m of me", and was taken back out. Kept because the reasoning error is a general one and worth being able to re-read.

> **Distance is the other half of "flat", and fog does it.** A night that is correctly lit at 20 m is still a diorama if the ridge at 800 m is a slightly dimmer version of the same thing. `fogDensity` at full dark goes **0.0004 -> 0.0022** and the night fog colour goes `0x121729` **->** `0x080b14`, which is darker than the night sky. Since `FogExp2` is `1 - exp(-(density x d)^2)` that gives 0.4% at 30 m, 5% at 100 m, 35% at 300 m, 82% at 600 m and 99% at 1 km: the near field is untouched, the middle distance loses its detail, and a far ridge becomes a black cutout against a lighter sky.
>
> This is not aerosol and the file says so -- the air does not thicken at 22:00. It is the same dark-adaptation problem as the rest of §8, viewed along the depth axis. A dark-adapted eye loses contrast sensitivity well before it loses light, so at night the far half of a landscape does not get dim, it stops *resolving*. An exponential-squared falloff toward a colour darker than the sky is that shape. It also has the useful side effect of making the aurora, the moon and the stars the brightest things in the frame by a wide margin, which at night they should be.

The gate promises that went with it, also retracted: unfogged at 30 m, under 10% at 100 m, **over 55% at 600 m and over 90% at 1 km**, fog luma below 80% of the horizon's, daylight density untouched. The last two survive; the two in bold were inverted into upper bounds.

**Why it was wrong.** Fog is applied *after* the lighting, so it is not a contrast effect at all -- it is a multiply toward a constant, and a density that erases a ridge at 600 m erases it however well the moon happens to be lighting it. "A dark-adapted eye loses contrast at distance" is a real observation, but the mechanism that models it is *lighting*, not *fog*: dimmer far-field illumination lowers the far field's contrast while leaving it visible. Fog toward near-black does not lower contrast, it deletes.
