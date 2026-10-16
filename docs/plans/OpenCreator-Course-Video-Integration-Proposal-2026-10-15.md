# OpenCreator × BrainBook (`bb_exam`) Course Video — Integration Proposal

Date: 2026-10-15
Status: proposal for review (research + plan only; no code changes)
Scope: `bb_creator` (OpenCreator) integrates directly with `bb_exam` (BrainBook LMS)
Reference only: `bb_video` is **not** a runtime dependency. It is used solely as a design reference for the course-video composition, pipeline stages, and local provider set.

---

## 0. Summary

- **Goal:** Add a native **Course Video** Creator tool to OpenCreator that turns a `bb_exam` course into narrated, captioned lesson videos, with a default local-GPU talking-head presenter and optional music and B-roll, and a strong preference for **local models**.
- **Integration target:** `bb_exam` (course creation) only. OpenCreator imports course content from `bb_exam` and produces the video itself. `bb_video` is retired to a reference role; OpenCreator must not shell out to it or depend on it at runtime.
- **Native rendering:** OpenCreator already renders Remotion through a versioned, SHA-256-verified **managed component** (`packages/stickman-remotion`, `apps/daemon/src/creator/stickman/remotion-*.ts`). We add a **`CourseLesson` composition** to this mechanism and render course videos entirely inside OpenCreator.
- **Recommended shape:** a new daemon template `course-video` (template id only, no protocol module) with a linear stage graph (`import → plan → narration → presenter → music → b-roll → render → assessment → deliver`), a `CourseLesson` composition added to the shared `remotion` component, a new `CourseVideoWorkspace`, a `courseVideoPanelAdapter`, and reuse of the single shared `CreatorCollaborationPanel`.
- **Models:** LLM = opencode `deepseek-v4.1-flash` (remote OpenAI-compatible endpoint, configured as a custom provider). Narration TTS = `edge-tts` (no key, local, word timestamps). Generative media (avatar/B-roll/music) = **local GPU + local video models run directly** through a thin purpose-built service wrapping diffusers (Wan 2.2 / LTX / CogVideoX) — **no ComfyUI**. This rides on `CreatorServicesConfig` and OpenCreator's executor/worker model.

---

## 1. Goals and non-goals

**Goals**

1. Create course lesson videos from `bb_exam` published courses, inside OpenCreator's workspace and Agent conversation.
2. Reuse OpenCreator's own Job/Stage/Artifact/version system and single collaboration panel — no parallel state, no second panel.
3. Run the media pipeline locally: `edge-tts` narration, **local GPU video models (no ComfyUI)** for avatar/B-roll, and the local renderer; LLM text via the opencode `deepseek-v4.1-flash` endpoint.
4. Keep course content traceable: re-rendering creates a new artifact version without overwriting earlier results.

**Non-goals (initial)**

- No runtime dependency on `bb_video` (no `build-lesson.sh`, no FastAPI SaaS, no `npx remotion` against the `bb_video` tree).
- No new per-seat or per-minute subscriptions; no cloud-only requirement.
- Learner playback changes only by the new optional per-version media: write-back adds a small, version-scoped media field/endpoint in `bb_exam` (§4.4); courses without video still render.
- No ComfyUI dependency — ComfyUI is not required and is not used.
- No full port of every `bb_video` provider in phase 1 — only `edge` TTS, local GPU video models (avatar/B-roll), and placeholder/kenburns fallbacks.

---

## 2. What exists today

### 2.1 `bb_exam` — the integration target (course creation)

- **Stack:** Next.js 14 (App Router), TypeScript, Prisma/Postgres (Supabase), shadcn/ui, LangChain, Zod.
- **Course model** (`bb_exam/schema/course.ts`):
  - `CourseContent`: `schemaVersion`, `title`, `description`, `modules[]`.
  - `CourseModuleContent`: `moduleKey`, `order`, `title`, `level` (`Entry` / `Entry - Specialty` / `Advanced` / `Advanced - Specialty`), `durationMinutes`, `summary`, `objectives[]`, `blocks[]`, `conversation[]`, `sourceRefs[]`, `quiz[]`.
  - `lessonBlock`: `kind` (`teaching` | `on_shift`), `title`, `body`, `sourceRefs[]`.
  - `conversationTurn`: `role` (`instructor` | `learner`), `text`, optional `audioAssetUrl`.
  - `quiz`: exactly 5 questions per module, 4 options each, `correctOptionId`, `explanation`, `objectiveIds[]`; default passing threshold 0.8.
  - `courseBrandingSchema`: `organization`, `logoUrl`, `heroUrl`, `presenterUrl`, `instructorAvatarUrl`, `learnerAvatarUrl`.
- **Course APIs** (`bb_exam/app/api/courses/**`):
  - Published course read (public): `GET /api/courses/public/[slug]`.
  - Authoring/manage: `/api/courses/[id]`, `/api/courses/[id]/versions`, `/api/courses/[id]/modules`, `/api/courses/[id]/publish`, `/api/courses/[id]/branding-assets`.
  - Generation: `/api/courses/[id]/generation-jobs`, `/api/internal/course-worker`.
  - Narration audio serving: `/api/voice/[...path]`.
- **Existing content:** *Understanding Behavior* (Arc Mercer) — 7 modules, 35 questions. (This matches the modules that `bb_video` was used to render as a one-off reference.)

### 2.2 OpenCreator (`bb_creator`) — the host and native capabilities

- **Creator tool registry (frontend):**
  - Tool cards: `apps/web/src/features/dashboard/DashboardPage.tsx` (`creatorTools`, L103–204; workspace→component `if` chain, L356–474).
  - Workspace↔template map: `apps/web/src/features/dashboard/creator-workspace.ts` (`CreatorWorkspace`, L9–21; `templateByWorkspace`, L52–64).
  - Protocol module allowlist: `packages/protocol/src/creator.ts` (`creatorRuntimeWorkspaces`, L124–131).
- **Single shared panel (mandatory):**
  - `CreatorCollaborationPanel.tsx` + `CreatorToolShell.tsx` + `creator-panel-adapters.ts`.
  - `CreatorPanelAdapter` contract (L29–54); progress contract is `phase / percent / message / completed / failed / total`; `genericAdapter` fallback (L56–72); dispatch via `creatorPanelAdapterFor()` (L952–964).
  - AGENTS.md "Creator template collaboration panel" rule: every template must share the one panel; differences only via adapter/config/callbacks/local slots; new templates must add adapter, activity filter/dedup, stage-status, and real-progress tests.
- **Execution path (button → backend):**
  - Web session store → `apps/web/src/services/creator-service.ts` (`POST /creator/jobs/:id/actions`) → daemon `apps/daemon/src/api/routes.creator.ts` → `command-dispatcher.ts` (`createStageRun`) → `stage-scheduler.ts` → `stage-runner.ts` → `CreatorExecutor.run()`.
  - Executors registered in `apps/daemon/src/api/server.ts` (L818–1013); templates registered in `apps/daemon/src/creator/templates/registry.ts` (L46–65).
  - Persistence: SQLite `creator_jobs`, `creator_stage_runs`, `creator_artifacts`, `creator_activities` (`apps/daemon/src/storage/migrations.ts`); artifact versions/snapshots per `docs/creator-artifact-versions.md`.
- **Native Remotion rendering (the key reuse):**
  - Managed component: `apps/daemon/src/creator/stickman/remotion-component.ts` downloads and SHA-256-verifies a release archive, then `remotion-runtime.ts` exposes `bundlePath`, `browserExecutable`, `rendererEntry`.
  - Executor: `remotion-executor.ts` writes a request, spawns `remotion-worker.ts` as a worker thread; the worker starts a local asset server and calls `@remotion/renderer` `selectComposition` / `renderMedia` with a composition id (`StickmanPortrait` / `StickmanLandscape`) and `inputProps`.
  - This is generic: a `CourseLesson` composition and a course asset server can be added the same way.
- **Model configuration (already local-capable):**
  - `packages/protocol/src/creator-services.ts` (`CreatorServicesConfig`): `llm` (OpenAI-compatible, `source: 'codex' | 'custom'`), `transcription` (includes local `funasr`), `tts` (openai/minimax/aliyun/volcengine/edge-tts), `image` (openai/jimeng/codex-native), `video` (seedance/kling/veo).
  - Provider catalog has a **`custom` "Custom OpenAI-compatible"** LLM entry: `packages/protocol/src/creator-provider-catalog.ts` (L31).
  - Settings UI: `apps/web/src/features/settings/CreatorServicesSettingsView.tsx`, `StartupAgentSetup.tsx` (custom base URL + key + model).
  - Local precedents: `docs/funasr-transcription.md` (local FunASR at `http://127.0.0.1:8000/v1`), `docs/development/codex-image-generation.md`.

### 2.3 `bb_video` — reference only

We borrow these **design ideas**, not the code or runtime:

- The course **module JSON shape**: `brand`, `courseTitle`, `moduleTitle`, `level`, `moduleIndex/moduleTotal`, `presenter {mode, layout, name, role, accentColor}`, `slides[] {kind, heading, sub, bullets, narration, audioSrc, captions[], durationInFrames}`, `assessment {passingPercent, questions[], attempt[]}`.
- The **stage decomposition**: TTS narration → optional music → optional B-roll → optional presenter → Remotion render → quiz scoring.
- The **provider abstraction** for voice/avatar/music/B-roll and the local-first defaults (`edge` TTS, `placeholder`/`kenburns` avatar, ComfyUI for ACE-Step / Wan / InfiniteTalk).
- The **word-level caption** requirement (word boundaries from TTS, or forced alignment for providers that don't emit them).

Everything above is re-implemented inside OpenCreator on OpenCreator's own contracts.

---

## 3. Design principles and constraints

1. **`bb_exam` is the single source of course content.** OpenCreator reads it; it never writes authoring data back in phase 1.
2. **No `bb_video` runtime dependency.** No script shell-out, no external FastAPI, no `npx` against the `bb_video` tree.
3. **One panel.** All course-video UI goes through `CreatorToolShell` + `CreatorCollaborationPanel`; template differences live only in `courseVideoPanelAdapter`.
4. **Native renderer.** Course videos render through OpenCreator's managed Remotion component, Web and Desktop sharing the same build.
5. **Local media by default.** The default configuration must produce a video without cloud media credentials: `edge-tts`, local GPU video models (no ComfyUI), local renderer. LLM text uses the opencode `deepseek-v4.1-flash` endpoint.
6. **Versioned results.** Re-render produces a new artifact version; earlier results are retained (`docs/creator-artifact-versions.md`).
7. **Standard progress.** Executors report only `phase / percent / message / completed / failed / total`; no executor-private fields reach the panel.
8. **Testability.** Course→lesson normalization and adapter/activity/progress behavior are unit-tested; the renderer follows the Remotion component verification path.

---

## 4. Target architecture

### 4.1 New Creator tool: `course-video`

- New workspace id `course-video` in `creator-workspace.ts`, a tool card in `DashboardPage.tsx`, and a render branch wrapping `CourseVideoWorkspace` in `renderCreatorWorkspace('course-video', …)`.
- New daemon template `course-video` (version 1) in `apps/daemon/src/creator/templates/course-video.ts`, registered in `registry.ts`. **Decision 4: template id only** — `course-video` is *not* added to the protocol `creatorRuntimeWorkspaces` preset-module list, matching the `stickman-video` / `auto-clip` precedent. The preset/module layer can be added later (non-breaking) if a preset gallery is wanted.
- New `apps/web/src/features/dashboard/CourseVideoWorkspace.tsx` using `CreatorToolShell`.
- New `courseVideoPanelAdapter` in `creator-panel-adapters.ts`, wired into `creatorPanelAdapterFor()`.

### 4.2 Pipeline stages and executors

| # | Stage | Executor | Input artifact(s) | Output artifact(s) | Local model |
|---|-------|----------|-------------------|--------------------|-------------|
| 1 | `import-course` | `course-import` | (bb_exam course ref) | `course-spec` | — |
| 2 | `plan-lesson` | `course-plan` | `course-spec` | `course-lesson` | opencode `deepseek-v4.1-flash` |
| 3 | `narration` | `course-narration` | `course-lesson` | `course-audio`, `course-captions` | `edge-tts` |
| 4 | `presenter` (default on) | `course-presenter` | `course-audio`, portrait | `course-avatar` | Local GPU talking-head model (direct); `placeholder`/`kenburns` fallback |
| 5 | `music` (optional) | `course-music` | `course-lesson` | `course-music` | Local GPU music model (direct), optional |
| 6 | `b-roll` (optional) | `course-broll` | `course-lesson` | `course-broll` | Local GPU video model (Wan 2.2 / LTX / CogVideoX, direct) |
| 7 | `render` | `course-video-remotion` | all media above | `course-video` | Local Remotion component |
| 8 | `assessment` (optional) | `course-assessment` | `course-spec` | `course-quiz-result` | deterministic scoring |
| 9 | `deliver` | `course-delivery` | `course-video` | thumbnail + VTT + snapshot | ffmpeg/ffprobe |

Stages 2, 4, 5, 6, 8 are optional and gated by draft settings (`allowedJobStatuses` / conditional actions), so a Tier-A run (narration + captions + render only) works with no GPU.

### 4.3 Native Remotion rendering

Follow the existing managed-component pattern (`docs/development/remotion-components.md`):

- **Shared `remotion` component (Decision 5, phase 1):** add a `CourseLesson` composition (landscape 16:9 first, portrait 9:16 later) to the existing managed `remotion` component's bundle (built from `packages/stickman-remotion`). Input props mirror the `course-lesson` artifact: slides (heading, sub, bullets, graphic), narration audio per slide, word-level captions, optional avatar clip, optional music track, optional B-roll clips, presenter metadata, branding, and assessment frames. The component is already generic in identity (id `remotion`, name "Remotion", generic resource kinds), so no new component id, release, signing, or notarization is needed; dev iteration uses a locally built component (`OPENCREATOR_REMOTION_COMPONENT_*`).
  - **Migration (later):** once the renderer stabilizes (P4/P5), or if bundle size / release cadence hurts, split the course composition into a dedicated `course-video` component. That requires generalizing `createRemotionComponentManager` (parameterize id / release path / root), the release-schema `id` literal, the `componentId` enum in `routes.creator-runtime.ts`, and the settings UI — deferred to keep phase 1 cheap.
- **New executor + worker:** `course-video-remotion` executor modeled on `stickman/remotion-executor.ts`, spawning a `course-video-worker.ts` modeled on `stickman/remotion-worker.ts`. The worker starts a local asset server that maps per-slide narration audio, avatar/B-roll clips, and fonts, then calls `@remotion/renderer` `selectComposition({ id: 'CourseLessonLandscape' | 'CourseLessonPortrait' })` and `renderMedia`, with the same path-escape guards and ffprobe validation as stickman.
- **Duration metadata:** `calculateMetadata` derives `durationInFrames` from summed slide durations + assessment frames (as `bb_video` did), so the worker's expected-duration check stays meaningful.

### 4.4 `bb_exam` integration contract

- **Read published course (decided):** `GET {bbExamBaseUrl}/api/courses/public/{slug}` is the **only** course source (no local export path). Configurable base URL; auth follows the public route (no author session required to read a published course).
- **Source of truth for the plan:** the `course-spec` artifact stores the raw `bb_exam` payload plus a `sourceHash` and `courseId`/`versionId`, so re-import detects drift and marks stale outputs.
- **Write-back (decided):** generated videos are written back into `bb_exam` as a **course version media artifact**. `bb_exam` has no media field on `TCourseVersion` today (`content` is Json; branding is separate), so this needs a small, additive `bb_exam` change — a version-scoped media store + attach endpoint mirroring the existing `branding-assets` pattern (privileged auth, same-origin, rate limit, size/MIME limits, storage key, audit), exposed to learners as short-lived signed URLs and optional in the learner DTO. **Full contract in [Appendix A](#appendix-a--bb_exam-version-media-contract-to-implement).** OpenCreator's `deliver` stage uploads the rendered MP4 (+ VTT/thumbnail) per module and records the returned URL on the artifact.
- **Robustness:** import validates with Zod, reports unsupported/empty modules explicitly, and never treats source text as instructions.

### 4.5 Course → lesson normalization (pure, tested)

A dedicated module (e.g. `apps/daemon/src/creator/course-video/normalize.ts`) maps `bb_exam` → OpenCreator's `course-lesson` model, deterministically:

- `moduleTitle` ← module `title`; `level` ← module `level`; `moduleIndex/Total` from module order.
- `slides[]` derived from module content: objectives → title/bullets slide; each `teaching`/`on_shift` block → content slide with `narration` from `body`; `conversation[]` → dialogue slides (instructor/learner roles); `summary` → recap slide.
- `assessment.questions[]` ← module `quiz` (`prompt`→`q`, `options[].text`, `correctOptionId`→`answer` index); `passingPercent` ← threshold.
- `branding` → brand string, presenter `name`/`role`/`accentColor`, portrait URL.
- The LLM `plan-lesson` stage may **refine** narration/headings (and, if enabled, generate slides), but the normalization output is always a valid, renderable `course-lesson` even without the LLM.

### 4.6 Local model wiring

| Capability | Local option | OpenCreator config point | Notes |
|------------|--------------|--------------------------|-------|
| Course text / lesson plan | opencode `deepseek-v4.1-flash` (remote OpenAI-compatible) | `CreatorServicesConfig.llm` — `source: 'custom'` + `baseUrl` + `model` | Settings UI already supports custom base URL |
| Narration TTS | `edge-tts` (no key, local, word timestamps) | `tts` provider `edge-tts` | Default; feeds word-level captions |
| Captions (non-edge TTS) | local FunASR / faster-whisper forced alignment | `transcription.provider: 'funasr'` + `baseUrl` | Only needed when TTS emits no word timings |
| Presenter / avatar (default on) | local GPU talking-head model run directly; `placeholder`/`kenburns` fallback | per-job draft (`avatar`, `avatarOptions`) | No ComfyUI |
| Music | local GPU music model (direct) or none | per-job draft (`musicProvider`) | Optional |
| B-roll | local GPU video model (diffusers service: Wan 2.2 / LTX / CogVideoX) | per-job draft (`brollProvider`, `brollModel`) | No ComfyUI |
| Render | Shared `remotion` component (`CourseLesson` composition) | managed component | No system npx/nvm |

Because `CreatorServicesConfig` already supports arbitrary OpenAI-compatible base URLs and `docs/funasr-transcription.md` establishes the local-service precedent, **no new provider plumbing is required** — only settings values and per-job draft options. Local video generation does not need ComfyUI: the executor runs the model directly (see §4.7).

### 4.7 Local GPU video generation without ComfyUI

ComfyUI is only one way to run local diffusion models; it is **not required**. OpenCreator's executors can drive local video models directly:

- **Chosen: a thin purpose-built local model service that runs diffusers directly.** A minimal FastAPI (or equivalent) service wraps the `diffusers` pipelines (health, submit, poll, cancel) and executes them on the local GPU; the `course-broll`/`course-presenter`/`course-music` executors call it over HTTP. This keeps the daemon/executor boundary clean and cancellation/health-checkable while still running the model directly — no ComfyUI and no general-purpose workflow engine. The service venv installs `torch`/`torchaudio`/`torchvision` (local GPU backend) + `diffusers`. Candidate models (as in OpenMontage's local catalog): `wan2.2-ti2v-5b` (12 GB+, default), `wan2.1-1.3b` (6 GB+), `ltx2-local` (8 GB+, fastest), `cogvideo-5b` / `cogvideo-2b`.
  - *Alternative considered and not chosen:* shelling out to OpenMontage's provider layer (`VIDEO_GEN_LOCAL_ENABLED=true`) — viable, but it makes a second product's tool contract a dependency; the purpose-built service is smaller and purpose-fit.
- **GPU backend (verified working).** The AMD Radeon 8060S (gfx1151, Strix Halo) is reachable in WSL through ROCDXG (`/dev/dxg` + `librocdxg`), and `torch 2.9.1+rocm7.13` in `bb_video/.avatar-venv` reports `torch.cuda.is_available() == True` with a successful GPU matmul. Note `/dev/dri` is intentionally absent on WSL; tools that require it will still report "no GPU" — use `/dev/dxg` / `amd-smi` / torch instead.

---

## 5. Data and protocol

- **New artifact kinds** (declared in the template's `inputArtifacts`/`outputArtifacts`, validated in `outputValidators`):
  `course-spec`, `course-lesson`, `course-audio`, `course-captions`, `course-avatar`, `course-music`, `course-broll`, `course-video`, `course-quiz-result`.
- **Course lesson model:** a Zod-validated schema in `packages/protocol` describing slides, captions, presenter, branding, and assessment — the input props for `CourseLesson`.
- **Versioning:** reuse `CreatorArtifact` + `CreatorResultSnapshot`; each render is a new version; `sourceArtifactIds` links outputs to the `course-spec` for stale detection when the course changes.
- **Progress:** executors emit `phase/percent/message/completed/failed/total` only; the adapter normalizes to panel text and never exposes internal stage ids.

---

## 6. Files to create / change

**Create**

- `CourseLesson` composition added to the existing Remotion bundle (`packages/stickman-remotion`) — landscape first, portrait later (Decision 5).
- `packages/protocol/src/course-video.ts` — `course-lesson` schema and shared types.
- `apps/daemon/src/creator/templates/course-video.ts` — template definition.
- `apps/daemon/src/creator/course-video/` — executors: `import.ts`, `normalize.ts`, `plan.ts`, `narration.ts`, `presenter.ts`, `music.ts`, `broll.ts`, `render-executor.ts`, `render-worker.ts`, `assessment.ts`, `delivery.ts`.
- `apps/web/src/features/dashboard/CourseVideoWorkspace.tsx`.

**Change**

- `packages/protocol/src/creator.ts` — register the new artifact kinds (no `creatorRuntimeWorkspaces` change: template id only, Decision 4).
- `apps/daemon/src/creator/templates/registry.ts` — register the template.
- `apps/daemon/src/api/server.ts` — register executors (L818–1013 region).
- `apps/daemon/src/creator/preflight.ts` — declare the new executors' service/runtime needs.
- `apps/web/src/features/dashboard/creator-workspace.ts` — workspace + template mappings.
- `apps/web/src/features/dashboard/DashboardPage.tsx` — tool card + render branch.
- `apps/web/src/features/dashboard/creator-panel-adapters.ts` — `courseVideoPanelAdapter` + dispatch.

**Change (`bb_exam`, write-back — Appendix A)**

- `prisma/schema.prisma` + migration — add `TCourseVersionMedia` (version-scoped media side table).
- `lib/course/source-store.ts` — `buildVersionMediaStorageKey`, `uploadPrivateVersionMedia`, `createSignedVersionMediaUrl`, media MIME/size limits.
- `app/api/courses/[id]/versions/[versionId]/media/route.ts` (new) — `POST`/`GET` attach/list, mirroring `branding-assets` (privileged, same-origin, rate limit, audit).
- `app/api/courses/[id]/enrollment/route.ts` + `lib/course/dto.ts` + `types/course.ts` — include per-module media (signed URLs) in the learner DTO; add re-mint endpoint.
- `lib/db-handler/course.ts` — version-media CRUD + audit action.

**Tests (required by AGENTS.md)**

- `apps/daemon/test/unit/creator-template-registry.test.ts` (+ course-video case).
- `apps/web/src/features/dashboard/creator-panel-adapters.test.ts` (adapter).
- Activity filter/dedup, stage-status, and real-progress tests for the new template.
- `apps/web/src/features/dashboard/CourseVideoWorkspace.test.tsx`.
- Normalization unit tests (`bb_exam` schema → `course-lesson`, including invalid/empty inputs).
- Remotion component download/verify/cancel/retry tests and a render smoke test.

---

## 7. Local model setup

1. **LLM:** point the LLM provider at the opencode `deepseek-v4.1-flash` OpenAI-compatible endpoint (base URL + model + key) via AI Services → LLM.
2. **TTS:** select `edge-tts` (no key).
3. **Local GPU video models (no ComfyUI):** run the thin purpose-built local model service (a small venv with `torch`/`torchaudio`/`torchvision` for the local GPU backend + `diffusers`) and select a model — `wan2.2-ti2v-5b` (default), `ltx2-local` (fastest), `cogvideo-2b` (lightest). The `course-broll`/`course-presenter`/`course-music` executors call the service over HTTP.
4. **Transcription (optional):** local FunASR at `http://127.0.0.1:8000/v1` for forced alignment when TTS lacks word timings.
5. **Renderer:** the shared `remotion` component installs on demand; no system Node/Remotion toolchain required at render time.
6. **GPU (verified working):** ROCDXG is installed (`/opt/rocm/lib/librocdxg.so`), `amd-smi static --asic` reports the GPU (`gfx1151`), and `bb_video/.avatar-venv` provides `torch 2.9.1+rocm7.13` with `torch.cuda.is_available() == True`. `HSA_ENABLE_DXG_DETECTION` is not required on HIP 7.13. Install `diffusers` into a venv to run the video models.

---

## 8. Phased milestones

| Phase | Deliverable | Exit criteria |
|-------|-------------|---------------|
| P0 | This proposal | Decisions in §11 confirmed |
| P1 | `course-lesson` schema + normalization + `CourseLesson` composition in the shared `remotion` component (landscape) | Renders one `bb_exam` module end-to-end with captions, natively |
| P2 | `course-video` template + executors + workspace + adapter | Full stage graph runs; shared panel, activity dedup, real progress pass |
| P3 | Local media: opencode LLM plan, `edge-tts`, local GPU video models (avatar/B-roll/music, no ComfyUI) | End-to-end video with local GPU media and no ComfyUI |
| P4 | `bb_exam` import (public API) + versioning + stale detection + write-back of rendered media to the course version (§4.4, Appendix A) | Re-render creates a new version; drift marks stale; rendered video attached to the `bb_exam` course version |
| P5 | Polish: cancel/resume, preflight, error diagnostics, Web/Desktop consistency, portrait; optionally split to a dedicated `course-video` Remotion component | Cancel/resume/preflight tests pass; parity checks pass |

---

## 9. Verification strategy

Graded per AGENTS.md:

- **P0/P1 (normalization, adapter, activity):** targeted vitest + package `typecheck`.
- **P1/P2 (executors, scheduler, artifact persistence):** daemon targeted integration tests — SQLite reopen persistence, cancel, resume, idempotency.
- **Renderer/component (P2):** phase 1 extends the shared `remotion` component, so run the managed-component download/verify/concurrency/cancel tests plus a render smoke test; if the component build/packaging changes, run the real Desktop package + web-hash gate.
- **End-to-end:** one module first (import → normalize → TTS → render → MP4 + VTT + snapshot), then all 7 modules.
- **Local-GPU proof:** confirm a B-roll/avatar render runs on the local GPU via the diffusers path with no ComfyUI and no cloud media keys (LLM may use the opencode endpoint).
- Do not run unrelated full suites/builds; escalate scope only when a trigger condition is met.

---

## 10. Risks and resolved questions

| Risk | Notes | Mitigation |
|------|-------|-----------|
| Renderer build/release | Extending the shared `remotion` bundle forces a shared component rebuild/release | Reuse the existing component pipeline; start landscape-only; split to a dedicated `course-video` component only if churn/size hurts |
| Caption word timings | Non-edge TTS lacks word boundaries | Default `edge-tts`; add local forced alignment for other providers |
| `bb_exam` schema drift | Two independently evolving schemas | Central Zod normalization + contract tests; import validates and fails visibly |
| Local model quality | LLM narration/quiz quality (opencode `deepseek-v4.1-flash`) | Keep Agent review + human approval stages; normalization always yields a valid lesson |
| GPU availability | Avatar/music/B-roll need a local GPU | Verified: ROCDXG + `torch 2.9.1+rocm7.13` (gfx1151) work; Tier A needs no GPU |
| Local video model cost | Large diffusion weights (Wan 14B, LTX-2) need VRAM/disk and setup | Start with `wan2.2-ti2v-5b` / `ltx2-local` / `cogvideo-2b`; B-roll stays optional |
| Write-back to `bb_exam` | `bb_exam` has no version-media field/endpoint yet, so write-back is a cross-project dependency | Add the small `bb_exam` media contract (§4.4); keep write-back as a distinct `deliver` step so it can be disabled if `bb_exam` lags |

**Resolved questions**

_None remaining — all four resolved:_ course source = `bb_exam` public API only; default presenter = local GPU talking-head model run directly; write-back = attach videos to a `bb_exam` course version as a media artifact; local video generation = a thin purpose-built local service running diffusers directly.

---

## 11. Decisions requested

1. **Approved** — the **native OpenCreator renderer** approach (no `bb_video` dependency); `bb_video` retired to reference-only.
2. **Approved** — `bb_exam` public-API import as the course source.
3. **Approved** — model configuration: LLM = opencode `deepseek-v4.1-flash`; TTS = `edge-tts`; avatar/B-roll/music = local GPU video models run directly (diffusers), **no ComfyUI**.
4. **Decided — template id only** (`course-video` v1), no protocol module; preset gallery deferred.
5. **Decided — shared `remotion` component for phase 1**, with an optional later split to a dedicated `course-video` component.
6. **Confirmed** — phase-1 scope: *Understanding Behavior* (7 modules), landscape first, Tier A baseline with optional GPU tiers.
7. **Decided** — course source: `bb_exam` public API (`/api/courses/public/:slug`) only.
8. **Decided** — default presenter: local GPU talking-head model run directly (`placeholder`/`kenburns` fallback).
9. **Decided** — write-back: generated videos are attached to a `bb_exam` course version as a media artifact (requires the small `bb_exam` media contract in §4.4).
10. **Decided** — local video generation: a thin purpose-built local service running diffusers directly (no ComfyUI, no OpenMontage dependency).
11. **Decided** — version-media immutability: media is an additive side table; attach before publish, post-publish additive attachment allowed only for privileged users and always audited (Appendix A.4).

---

## Appendix A — `bb_exam` version-media contract (to implement)

Write-back (§4.4) needs a small, **additive** change in `bb_exam`. This appendix specifies it against the existing patterns (`branding-assets` route, `lib/course/source-store.ts`, `lib/course/auth.ts`, `lib/course/http.ts`, `lib/course/rate-limit.ts`, `courseHandler.createAuditLog`).

### A.1 Data model (Prisma)

Add `TCourseVersionMedia` (schema `bb_exam`) and the back-relation on `TCourseVersion`; ship via a Prisma **migration** (not `db push`):

```prisma
model TCourseVersionMedia {
  id              String   @id @default(uuid())
  versionId       String
  moduleKey       String
  kind            String   @default("lesson_video") // lesson_video | captions | thumbnail
  storageKey      String
  mimeType        String
  size            Int      @default(0)
  sha256          String   @default("")
  durationSeconds Float?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  TCourseVersion  TCourseVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)

  @@unique([versionId, moduleKey, kind])
  @@index([versionId])
  @@schema("bb_exam")
}
```

One active row per `(versionId, moduleKey, kind)`; re-upload replaces it (and removes the prior storage object).

### A.2 Storage (`lib/course/source-store.ts`)

- New private bucket `COURSE_MEDIA_BUCKET` (default `files`), reusing the signed-URL helpers (10-minute TTL) — media is access-controlled, unlike public branding.
- `buildVersionMediaStorageKey(orgId, courseId, versionId, moduleKey, kind, mimeType)` → `course-media/{safeOrg}/{courseId}/{versionId}/{safeModuleKey}/{kind}-{uuid}.{ext}`.
- `uploadPrivateVersionMedia(...)` and `createSignedVersionMediaUrl(storageKey, ttl)`.
- Limits: `MEDIA_MAX_BYTES` (e.g. 512 MB video; 2 MB captions/thumbnail); allowed MIME `video/mp4`, `text/vtt`, `image/png|jpeg`.

### A.3 Endpoints

- **`POST /api/courses/{id}/versions/{versionId}/media`** — multipart (`file`, `moduleKey`, `kind`):
  - `requireAuth` → `courseHandler.getCourseById` → `requirePrivileged(context, course.ownerId)` → `assertSameOrigin` → `enforceRateLimit(rateLimitKey(req, 'media-upload', userId), 30, 60_000)`.
  - Validate `version.courseId === course.id`, `moduleKey` exists in the version, and MIME/size.
  - Upload private; upsert `TCourseVersionMedia` by `(versionId, moduleKey, kind)` (remove prior object); `createAuditLog({ action: 'version_media_uploaded', metadata: { moduleKey, kind, sha256 } })`.
  - Returns `{ success: true, media: { moduleKey, kind, url } }` (author signed URL).
- **`GET /api/courses/{id}/versions/{versionId}/media`** (privileged) — list media with signed URLs.
- **Learner read** — extend `GET /api/courses/{id}/enrollment` to include per-module media (short-lived signed URLs); add `GET /api/course-enrollments/{enrollmentId}/modules/{moduleId}/media` to re-mint URLs on demand.

### A.4 Versioning / immutability (decided)

Published versions stay content-immutable; media is an **additive side table** that never changes `content` or `schemaVersion`.

- OpenCreator renders from the course's draft/approved version and attaches media **before** publish, so the published version ships with its video.
- Post-publish additive attachment is allowed **only for privileged users** and is always recorded in the audit log; it adds a side-table row without mutating published content.
- Learner-visible media is resolved from the enrolled/published version, so attaching media never changes what another version's learners see.

### A.5 Learner DTO and player

- `types/course.ts`: add `LearnerModuleDTO.media?: { videoUrl?: string; captionsUrl?: string; thumbnailUrl?: string }`.
- `lib/course/dto.ts`: populate from media rows; **omit when absent** so courses without video still render.
- Learner player (`app/courses/[slug]/_components/`): play the video when present; otherwise keep the existing text/conversation/speech path.

### A.6 OpenCreator side

- The `deliver` stage uploads the MP4 (+ VTT + thumbnail) per module via the `POST` endpoint and records the returned URL on the `course-video` artifact.
- New config: `bbExamBaseUrl` + `bbExamToken` (a **privileged** `bb_exam` bearer token). Preflight fails clearly if the token lacks privileged scope or the target version is not attachable.

### A.7 Tests

- Endpoint: auth/privilege/ownership, same-origin, rate limit, MIME/size, version+module validation, upsert-replace, audit, signed-URL shape.
- Learner: DTO includes media only when present; two enrollments stay isolated; expired signed URL re-mints.
- Migration: version-delete cascades media; unique constraint holds.
