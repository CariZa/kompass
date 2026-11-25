# Kompass: handoff to Claude Code

Start here, then read `SPEC.md` (the full design spec).

## What we're building
Kompass is a **read-only** Kubernetes desktop navigator: an OpenLens alternative built with **Wails + Go**, with a vanilla TypeScript or Svelte frontend (your choice). It's for jumping between many clusters fast during incidents. The design and the reasoning behind each choice are in `SPEC.md`. **Layout Option B** is the chosen layout.

## Hard constraints (non-negotiable)
1. **Read-only.** The client may only `get`, `list` and `watch`. There is no apply, edit, patch, delete, exec, port-forward or scale code path anywhere. Add a test that fails if any non-read verb is reachable, e.g. by wrapping the REST client so it rejects anything else.
2. **Nothing stored.** Load `~/.kube/config` plus `$KUBECONFIG` with `clientcmd`, the way kubectl does. Auth goes through the kubeconfig's exec plugins (`aws eks get-token`, `gke-gcloud-auth-plugin`, Teleport). Tokens stay in memory. Never write the kubeconfig, never change `current-context`, and don't create a cache, settings file or log containing cluster data.
3. **The active context is in-app only.** Opening a context in Kompass doesn't affect the terminal.

## Files in this folder
| File | Use |
|---|---|
| `SPEC.md` | The full spec: screen zones, category rules, discovery, Describe/YAML views, preview tabs, pop-out windows, data model, open questions. |
| `tokens.json` | Design tokens (colors with dark and light themes, type, spacing, radius, sizes). This is the source of truth. |
| `tokens.css` | The same tokens as CSS custom properties. Generated, so don't hand-edit it. |
| `mockups/LayoutB.html` | **The target UI.** A working mockup with mock data. Open it in a browser and match its behaviour and look. |
| `mockups/LayoutA.html` | The alternative layout. Use it as a reference only (the inline resource tree and the pop-out window example). |
| `mockups/Home.html` | The context picker. |
| `mockups/Wireframes.html` | Annotated wireframes. Hover the numbers. |

The mockups' JavaScript is throwaway prototype code: reuse the behaviour and CSS, but don't treat it as architecture. The mock data inside them (contexts, pods, CRDs) is fake.

## Suggested milestones
1. **Skeleton.** Wails app, Go `Contexts()` (parse the kubeconfig and derive short name, `where` and env as in the mockup's `parseCtx`), and the Home screen with multi-term search.
2. **Connect + discover.** Per-context client, `Discover()` via `ServerPreferredResources`, and the right nav with built-in categories, Custom Resources grouped by API group, Uncategorized, counts, the namespace dropdown and the type filter.
3. **List tabs.** Informer-backed tables (start with Pods: Name, Status, Ready, Restarts, Age, Namespace, Node), with a name filter and live updates.
4. **Resource views.** Describe via `k8s.io/kubectl/pkg/describe` (`DescriberFor` / `GenericDescriberFor`) and YAML with `managedFields` stripped. Each is its own tab. Preview tabs: single click opens, double click keeps. Find with n of N and Enter / Shift+Enter.
5. **Editor groups.** Split 50/50 with a draggable divider, drag tabs between groups, and keep a separate workspace for each context (⌘1–9).
6. **Pop-out windows.** Wails v3 multi-window, see the open questions.

## Open questions (ask the owner before deciding)
- **Wails v3 (beta, multi-window) or v2 (single window, in-app floating panels for pop-outs)?**
- Should the open-contexts rail persist across restarts? Right now it resets each launch, to respect "nothing stored".
- Secrets: masked with per-key reveal, or never shown?
- The real Widget CRD API group. `example.com` is a placeholder.
