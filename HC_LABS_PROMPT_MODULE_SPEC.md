# HC Labs Prompt Module Spec

The current release isolates provider routing first. Prompt modules remain a planned compiler layer and must not be embedded in provider clients.

Recommended module groups:
- `core`: identity, realism, quality
- `product`: product/packaging lock
- `character`: identity/consistency
- `camera`: close-up, medium, macro, handheld, cinematic
- `lighting`: studio, natural, cinematic, luxury
- `scene`: bedroom, hotel, studio, outdoor
- `content`: UGC, commercial, review, unboxing
- `negative`: product, anatomy, typography, realism

Each future module requires `id`, `version`, purpose, inputs, instruction, priority, and compatibility. Hard identity constraints outrank soft style preferences and negative constraints are appended last.
