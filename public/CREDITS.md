# Credits

GonGon ships two third-party 3D models. Everything else (ground, props, HUD, audio) is generated in code.
No proprietary game assets are used. Project Zomboid was studied as reference only; none of its art,
models, sounds or UI is included (see `cook/PZ-RESEARCH.md`).

## Models

| File | Model | Author | License | Source |
|---|---|---|---|---|
| `src/assets/models/survivor.glb` | Soldier (rigged, 24 animations) | Quaternius | CC BY 3.0 | https://poly.pizza/m/oAArCNHjFB |
| `src/assets/models/zombie.glb` | Animated Zombie (rigged, 5 animations) | Quaternius | CC BY 3.0 | https://poly.pizza/m/jkrEvQZb8J |

License texts:
- CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/

Attribution as required by CC BY 3.0: the models are by **Quaternius** (https://quaternius.com), distributed
via poly.pizza under CC BY 3.0.

### Modifications (CC BY 3.0 requires these to be stated)

Both models were changed for GonGon:
- Uniform scaling to a 1.8 m humanoid, and re-parenting under an animation mixer.
- Material changes: the survivor's clothing materials are recoloured to a dark navy jacket with cream
  trousers; zombies are recoloured to a desaturated olive/grey decayed palette, with upper and lower body
  tinted differently, and are pitched forward to read as hunched.
- **An original red conical hat was added to every character.** It is GonGon's own geometry (a cone, a brim
  disc and a tip sphere, generated in code), attached at runtime to each model's `Head` bone so it follows
  every animation. No part of the hat comes from the source models.
- The survivor carries a procedurally generated weapon prop.

The base rigs, skeletons and animation clips remain the unmodified Quaternius assets; the visual identity of
the characters (uniform, palette, hat, posture) is GonGon's own and is not a Project Zomboid reproduction.

Squad followers reuse the survivor model with a different material tint.

## Code

- three.js — MIT — https://threejs.org
- ws — MIT — https://github.com/websockets/ws
- Vite — MIT — https://vitejs.dev

## Audio

All sound effects are synthesised at runtime with the Web Audio API. No sample files.
