# Sugar

Web application for high-level hardware block diagrams. It includes a reusable versioned block library, typed ports, YAML editing, project history, team roles, English/Spanish and light/dark themes. The Vue interface uses Tailwind CSS for utilities and component styling, with a small amount of custom CSS for the diagram canvas. The application is independent from Antmicro's Visual System Designer.

## Start

From this directory, run:

```sh
docker compose up -d --wait db
docker compose --profile maintenance run --build --rm migrate
docker compose up --build -d
```

Open [http://localhost:8088](http://localhost:8088). Before first boot, create a private `.env` (mode `600`) set `RUNTIME_DB_PASSWORD` to 64 random hexadecimal characters, and set `ADMIN_PASSWORD` explicitly (at least 12 characters, at most 72 UTF-8 bytes). The first boot creates `admin@local` or your configured `ADMIN_EMAIL`; it never prints the password. Existing accounts are not changed by bootstrap settings. `.env.example` lists all options. Set `APP_PORT=127.0.0.1:8089` if port 8088 is occupied. Omitting the IP explicitly (for example `APP_PORT=8089`) publishes on all interfaces; use that only for deliberate LAN access. Production uses `deploy/compose.yaml` and its separate network policy.

The same Compose file starts the web frontend, API and PostgreSQL. Data is kept in the `postgres_data` Docker volume across restarts and rebuilds. Back up that volume before moving or upgrading an installation. For access outside a trusted local network, serve the app through HTTPS and set a strong `DB_PASSWORD` in `.env` before the first boot.

## Working with diagrams

- **Projects:** create or import a YAML diagram. Add blocks by clicking `+` or dragging from the library; connect their ports, select a connection and drag a control point at the middle of a segment to route it around other lines. The vertical segment moves horizontally and the horizontal segment moves vertically; corners stay rounded. Edit selected block fields and save a revision with a summary. The right panel shows properties, YAML and history. On wide screens, use the YAML width slider to resize the right panel. The navigation sidebar and the block palette can each be hidden with their buttons to give the canvas more space.
- **Project settings:** each project records its creator and starts private. Its creator or an `Admin` can switch it to public, select a GitHub repository (`owner/repo`) and branch, and copy a read-only sharing link. Public projects are visible to everyone with the link; private projects are visible to their creator and admins, while a private sharing link grants read-only access to its holder. Private links expire after seven days and can be revoked; creating a link after expiry generates a new token. Settings changes are recorded separately from YAML revisions.
- **Library:** edit a block definition in YAML. Use **Expand editor** to hide the block list and give the YAML the available width. Validation errors stay visible at the top of the screen and beside the editor. Every save creates an immutable version. Existing projects contain the selected version's snapshot, so they do not change until someone updates an instance deliberately. A block can show an identifying image from an HTTPS URL or a gallery URL. Upload PNG, JPEG or WebP images (up to 1 MB) in **Image gallery**, copy the URL, then paste it into a block image field. YAML stores only the URL. Gallery images are stored in PostgreSQL and included in the Compose volume backup. If the URL stops working, assign another image URL.
- **Library ownership:** accounts can read the shared catalog and their own personal blocks/categories. `dev` users create personal resources; `Admin` can choose personal or shared scope and maintain all resources. Only Admin can modify shared catalog entries. Use **Create personal copy** to adapt a catalog block without changing its original. Existing resources migrate to the shared catalog without changing YAML, versions or project references.
- **Categories:** editable accounts manage a two-level personal category tree; Admin maintains shared categories. Block YAML stores a stable `category` and optional `subcategory` slug. New and edited library blocks require an active category; older blocks remain available under **Uncategorized** until classified. Expand category and subcategory rows independently in the library or canvas palette. Search both lists by name, function, model, category, port label or protocol; search ignores accents and case. Renaming a category preserves its slug and existing YAML. Categories in use cannot be removed.
- **Image gallery:** `dev` and `Admin` upload personal images; only Admin can upload shared catalog images. The gallery lists your images and the catalog (Admin can manage all). Readers of blocks/projects using an image can load it without gaining access to the uploader’s gallery. Anonymous downloads require a current public-project reference or a valid private sharing link. Private links expire after seven days and can be revoked. Only Admin can delete images. Images and shared responses use `private, no-store`; see `api/README.md` for reuse, migration and cache policy.
- **Block properties:** select a block on the canvas to see its `properties` values. Set the optional top-level `color` to change only its header; the editor chooses readable text and icon contrast. Use `properties.notes` for multiline notes and `properties.urls` for named HTTP(S) links such as datasheets and papers. The inspector and library editor can edit these fields. Existing `properties.url` links remain supported. Library values are copied into projects and can be changed per instance.
- **History:** compare two revisions with a text diff, or restore one as a new revision. Concurrent edits return a conflict instead of overwriting changes.
- **Export:** project YAML includes its block snapshots. Gallery image URLs resolve on the same installation; for use elsewhere, replace those URLs or host the images at stable HTTPS addresses. SVG and PNG exports capture the current canvas viewport.

Example block:

```yaml
name: Temperature sensor
function: Measure ambient temperature
model: BME280
category: sensores
subcategory: temperatura
# Optional: HTTPS image URL or a URL copied from the gallery.
image: https://example.com/bme280.png
color: "#2040A0"
properties:
  range: -40..85 °C
  notes: |-
    Mount away from the power regulator.
    Check the enclosure temperature rise.
  urls:
    - datasheet: https://example.com/bme280-datasheet.pdf
    - paper: https://example.com/bme280-paper.pdf
ports:
  - id: i2c
    label: I²C
    protocol: I2C
    direction: bidirectional
    maxConnections: 1
  - id: power
    label: Power
    protocol: POWER
    direction: in
    maxConnections: 1
    color: "#FF0000"
```

A port can use any non-empty protocol text, such as `I2C`, `CSI`, `LVDS`, or `PAC`. Two ports connect when their protocol text matches after trimming outer whitespace; matching is case-sensitive. Directions are `in`, `out`, and `bidirectional`. Connections show an arrow toward their target; when both ports are bidirectional, they show arrows at both ends. The server also validates direction, port existence and connection limits. A port may set `color` to a six-digit RGB hexadecimal value (for example `"#FF0000"`). The source port color paints the connection; if it has no color, the target port color is used. Quoted values follow standard YAML. The editor also accepts an unquoted six-digit color such as `color: #FF0000` and quotes it when the block is saved. The YAML editor accepts an unfinished draft but will not apply or save it until validation succeeds.

## Roles

| Role | Permissions |
| --- | --- |
| `view` | View projects, blocks, revisions and export diagrams. |
| `dev` | Create and edit projects and personal block definitions/categories; read shared catalog; remove nodes and edges inside a diagram. |
| `Admin` | All `dev` actions, plus account management and deletion of projects and library blocks. |

An administrator creates user accounts. In **Settings → Active sessions**, users can close another session or all other sessions. Logout revokes its server-side identity; changing a password closes every session, including the current one. Sessions expire after seven days and survive API restarts. Releasing the revocable-session migration requires everyone to sign in again; see `api/README.md`. Deleted users are deactivated so revision authorship remains available. Deleting a project or library block hides it from the app while retaining its history in PostgreSQL.

## Optional GitHub synchronization

GitHub synchronization is being migrated to per-account GitHub App user authorization (#22). Global installation credentials are no longer consumed. Existing project destinations and history are retained, but old jobs are blocked until the project owner reconnects and explicitly authorizes the destination. The new backend is prepared; the connection/selection interface and callback are still pending. Keep `GITHUB_CONNECT_ENABLED=false` until that stage and the owner's GitHub App configuration are reviewed. See [API development status](api/README.md#github-account-authorization-foundation-issue-22).

The API queues each project revision as a separate YAML file under `projects/<id>/revision-<n>.yaml`. Library blocks and their version history remain in PostgreSQL; a project's YAML includes its selected block snapshots. Legacy pending library synchronization jobs are marked skipped; their records and previously published files are retained. Projects are queued only after their own repository is configured; the current revision is queued when a repository is first selected. A background loop sends jobs to their selected repository and retries with backoff after errors. The app works without GitHub; pending revisions remain in PostgreSQL. Synchronization only publishes outward. Changes made in GitHub must be imported explicitly. GitHub is an audit copy, so deleting a record in the app does not erase already published history from the repository. Check the destination repository's visibility before syncing a private project.

## Development and tests

The `web/` directory contains Vue 3, TypeScript, Vue Flow and Tailwind CSS. The `api/` directory contains Express, YAML validation and PostgreSQL access. Run `npm test` in `api/` and `npm run build` in `web/` to check the main logic and production frontend. `docker compose up --build -d` also builds both images and starts the complete system.

## Project AI reviews

An Admin can configure **Artificial intelligence** in global **Settings**. The initial provider is DeepSeek, with `deepseek-flash` and `deepseek-v4-pro`. Generate `AI_ENCRYPTION_KEY` once with `openssl rand -hex 32`, put the 64 hexadecimal characters in `.env`, and restart the API. This independent key encrypts the API token using AES-256-GCM before it is stored in PostgreSQL. Back up the key securely with the database; replacing or losing it makes the stored token unreadable. The API never returns the token. An empty token field preserves it; **Remove token** removes it and disables AI. Save settings before testing the connection; the test sends a small billable request. Admin configures request/token budgets and the period in **AI quotas**. PostgreSQL reserves capacity before calling, across all API replicas; connection tests also count. The project AI panel shows remaining quotas and renewal time. Failed or uncertain calls retain a conservative reservation and are never retried automatically. Quotas represent tokens/requests, not money or the DeepSeek balance; see `api/README.md`.

In a project, **Review with AI** at the bottom right of the canvas opens the AI inspector. Admin and dev can **Analyze** or **Recommend**, with an optional focus (2,000 characters). View users can read saved results for projects they may access. Shared/public unauthenticated pages do not expose analyses. Each request reviews the current applied canvas, including unsaved changes, without creating a YAML revision. Apply pending YAML first. Editing after submission marks the result as belonging to an earlier state.

Only the current project name, block definitions (without images), properties, ports, connections and focus are sent to DeepSeek. Known credential/media property keys are omitted recursively. Do not put secrets in free-text descriptions or focus: free text is still sent. No images, previous analyses, other projects, app credentials or user accounts are sent, and links/datasheets are not fetched. Reviews are advisory and cannot modify the diagram; verify electrical compatibility independently. Each review is independent, with instructions restricting it to the project and treating its content as untrusted data; model adherence is not a substitute for electrical validation.

Successful results, author, timestamp, snapshot, hash, base revision, model and reported usage remain in PostgreSQL, separately from project revisions and GitHub synchronization. History is paginated (20 results). The provider request has a 200 KiB context limit, 4,000 output token limit and 120 second timeout; oversized context or truncated output is reported instead of silently shortened. One request per user may run at a time in the current single-process API. Requests are never automatically retried. If a network error occurs, refresh history before submitting again to avoid spending credit twice.

The endpoints are `GET/PUT /api/ai`, `POST /api/ai/test` (Admin), `GET /api/ai/status` (authenticated availability only), and `POST/GET /api/projects/:id/analyses` plus `GET /api/projects/:id/analyses/:analysisId`. Creation accepts `{ snapshot, action: 'analyze'|'recommend', focus, language: 'es'|'en', baseRevision, requestId }`; a UUID request ID makes completed request replay idempotent. Reusing it with different input is rejected. History accepts `?offset=0` and returns `{items,nextOffset}`; detail includes the snapshot and plain-text response. Existing project visibility checks apply to every analysis route. Backups of PostgreSQL include analysis history.

`npm test` in `api/` includes mocked DeepSeek and HTTP route tests without a real token or paid requests. Production UI verification requires `npm run build` in `web/`. Test real-provider connectivity after configuring a valid token.

The optional `AI_TEST_URL` integration suite is destructive to its **test environment**: it creates accounts/projects and changes AI configuration. Run it only against a fresh isolated database and the test provider in `api/test-support/deepseek-mock.mjs`, loaded via Node `--import`. Set the isolated initial admin password to `local-ai-verification-password`, serve the test API behind the web proxy, then run `AI_TEST_URL=http://127.0.0.1:8090 node --test src/ai.integration.test.js` from `api/`. Without this variable, the integration suite is skipped; ordinary unit/route tests still run. Never point `AI_TEST_URL` at the main installation.


## Sugar appearance and category icons

Sugar uses a continuous top bar with its sugar-grain mark and wordmark; collapsing navigation never hides the brand. The default theme for new accounts is warm white with burnt orange. Existing users retain their theme preference, and the optional dark theme uses neutral graphite and orange. Explicit port colors still determine connection colors; the theme supplies only the default.

The category owner (or Admin for the shared catalog) selects a default icon when creating a top-level category, using the searchable 16-symbol Heroicons picker. Subcategories inherit their parent's icon unless an override is selected. The same picker can edit an existing category. Blocks display their own image first, then their subcategory icon, category icon, or generic cube. Category changes update the library and existing diagrams on reopening/reloading; they do not create block versions, project revisions, YAML fields, AI context, or GitHub jobs. Archived category metadata remains available for historical snapshots. Unknown category slugs use the generic icon.

Category API responses include `icon`; creation/editing accept a supported icon ID, and subcategories accept `null` to inherit. Older creation requests without an icon receive `cube` for a root or inheritance for a child. Edits omitting the field preserve the existing icon. Supported IDs: `cube`, `power`, `battery`, `cpu`, `sensor`, `temperature`, `network`, `radio`, `display`, `storage`, `motor`, `audio`, `light`, `connector`, `clock`, `shield`. Public/shared project responses include `category_icons`, restricted to slugs already referenced by their YAML.

`ICON_TEST_URL` enables the optional category integration test against a fresh, disposable installation with initial password `local-icons-verification-password`. It creates categories, accounts, blocks and projects; never target the main installation. Standard `npm test` skips this integration test when the variable is unset.


### Connection routing handles

Selected connections expose a separate handle for each non-zero routing segment: source-side vertical leg, middle horizontal segment and target-side vertical leg. Drag a vertical leg sideways or the horizontal segment up/down. Moving the target-side handle creates a final horizontal lead back to its port, allowing a line to be separated from a block without moving the block or disconnecting the port. Existing `{x,y}` routes keep their geometry; an optional `route.targetX` is saved only when that extra leg is adjusted. **Reset route** clears all three coordinates. Short/zero-length segments do not show a handle; they appear when the route has enough space.

## Despliegue continuo

La configuración de GitHub Actions, imágenes GHCR y despliegue en `sugar.maykolrey.com` está documentada en [deploy/README.md](deploy/README.md). Cada push a `main` valida, publica imágenes por commit y actualiza producción conservando los datos.

## Arquitectura del backend

El API se organiza por funcionalidades y separa `createApp()` del arranque del proceso. Consulta [api/README.md](api/README.md) para añadir rutas, servicios, consultas y pruebas de integración aisladas, incluidos los límites transaccionales de revisiones y sincronización.

PNG and SVG exports include a small Sugar cube-and-name watermark in the bottom-right corner. It follows the selected theme and stays fixed in the exported image regardless of diagram zoom; it is not saved in project YAML.
