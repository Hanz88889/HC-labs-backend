# HC Labs Prompt Compiler — Schema

`hclabs.content-plan.v1` is provider-independent:

```json
{
  "schema":"hclabs.content-plan.v1",
  "goal":"image|video|edit",
  "format":"string",
  "tone":"string",
  "creative_direction":"string",
  "generation_prompt":"string",
  "duration_seconds":null,
  "generation":{"mode":"text-to-image","aspect_ratio":"1:1","camera_motion":"string"},
  "scenes":[]
}
```

Rules: image=`text-to-image`, edit=`image-to-image`, video=`text-to-video`; aspect ratio is one of `1:1`, `16:9`, `9:16`, `4:5`; video has exactly three scenes totaling 15 seconds. Backend attaches `conversation_id` after validation.
