# Kompass

A read-only Kubernetes desktop navigator (Wails + Go) for jumping between many clusters fast, built around one question during an incident: *how quickly can I get from "something is wrong in prod EU" to the YAML that explains it?*

"Kompass" is a working title. The Screens cards (Home, Option A, Option B) are clickable mockups running on mock data: type in the filters, open contexts, open tabs, split the editor, step through YAML matches.

## Principles

1. **Read-only by construction.** The Go side only ever calls `get`, `list` and `watch`. There's no apply, edit, delete, exec or port-forward code path in v1, so the UI can't offer what the binary can't do. The context bar always shows `Read-only · get / list / watch`.
2. **Your environment, nothing stored.** Contexts come from `~/.kube/config` plus `$KUBECONFIG`, loaded the way `client-go` loads them. Auth goes through the kubeconfig's own exec plugins (`aws eks get-token`, `gke-gcloud-auth-plugin`, Teleport). Tokens live in memory only. Kompass never writes kubeconfig, config files, caches or secrets to disk.
3. **Never lose your place.** Each open context keeps its own workspace: namespace, filter, tabs and split. Switching contexts (⌘1–9) swaps the whole workspace, not just the API target.
4. **Know which cluster you're in.** Long context names get reduced to a *short name* (the cluster name parsed out of EKS ARNs, `gke_project_zone_name`, eksctl and Teleport forms), plus an *environment chip* derived from the name (prod, staging, dev, local). Short names wrap at hyphens and never truncate. The full name stays one click away (copy button, tooltip).
5. **Keyboard first, incident speed.** `⌘K` finds a context, `/` filters resource types, `⌘F` searches the open Describe or YAML view, `Enter` / `Shift+Enter` step through matches, `⌘\` splits the editor.

## The screen

| Zone | What lives there |
|---|---|
| **Left rail** (`rail-width`) | *Open contexts*, newest on top. Each row shows the short name, an env chip, region · account, a `⌘n` hint and a close `×`. Opening a context from Home puts it on top. Clicking a context in the rail doesn't reorder it, so `⌘1–9` stay stable while you flip between clusters. |
| **Context bar** (top of middle) | Env chip, short name, where it runs, the full context name (copyable), and the read-only pill. A 2px strip in the env colour (`env-prod` red, `env-staging` amber, `env-dev` blue) runs along its top edge. Prod should feel different at a glance. |
| **Middle** (widest) | Tabbed editor. Each resource you open becomes a tab. `⌘\` splits it 50/50 into two editor groups, like VS Code, and the divider can be dragged. Each group has its own tabs and its own find bar. The focused group's active tab carries the `accent` top line. |
| **Right nav** (`nav-width`) | Namespace dropdown (All namespaces, or one), then the type filter, then **Cluster** (info card), then the categories. |

### Categories in the right nav

Built-in groups, in this order: **Nodes · Workloads** (Overview, Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Replication Controllers, Jobs, CronJobs) **· Config · Network · Storage · Namespaces · Events · Helm · Access Control · Custom Resources · Uncategorized**.

- The full type list comes from the **discovery API** (`ServerPreferredResources`), so each context shows exactly what its API server serves.
- Every kind backed by a CRD goes under **Custom Resources**, sub-grouped by API group (`storage.gcp.m.upbound.io → Buckets, BucketObjects`). The CRDs themselves are listed there as *Definitions*.
- Any discovered kind that isn't in a built-in group and isn't a CR lands in **Uncategorized** (APIService, FlowSchema, CSIDriver…). Nothing gets dropped.
- **Visibility rule:** a category hides only when it has nothing to show in the current namespace scope. Cluster-scoped kinds always count, and get a `cluster` tag when a single namespace is selected. The text filter **never hides a category**: a category with no matching types stays, dimmed, with its heading.
- **Filter matching:** label, kind, short names (`po`, `sts`, `pvc`, `crb`…) and API group, so `upbound` finds every Crossplane GCP kind. Space-separated terms must all match. In Option A the filter also matches resource *names* and auto-expands the types that contain them.
- **Port Forwarding** is listed but disabled (`v2 · needs write`), because it needs `pods/portforward` create.
- **Helm** releases are read from the `sh.helm.release.v1.*` secrets and decoded in memory.

### Resource views: Describe and YAML

A resource has two read-only views to start with. Each one opens as its **own tab**:

| View | Equivalent | Notes |
|---|---|---|
| **Describe** (default) | `kubectl describe` | Rendered by `k8s.io/kubectl/pkg/describe` on the Go side: `DescriberFor` for built-in kinds, `GenericDescriberFor` for CRs. That's the same code kubectl runs, so the output matches the terminal. Includes the resource's Events. |
| **YAML** | `kubectl get -o yaml` | Syntax-coloured, `managedFields` hidden by default. Secret values are masked. |
| Logs (next) | `kubectl logs` | Shown disabled for Pods. It's still read-only (`pods/log`), so it's the natural third view. |

**Opening resources** works like VS Code:
- **Single click** opens Describe in a *preview tab* (italic title). The next single click replaces it, so browsing doesn't pile up tabs.
- **Double click** opens Describe and keeps the tab. Double-clicking a preview tab also keeps it.
- The **Describe │ YAML │ Logs** switch in each tab's toolbar opens the other view as a new tab next to the current one. A resource can have both open at once, side by side in a split.
- In Option B, rows open in the *other* editor group when the editor is split.

**Find** works the same in both views: ⌘F, `n of N`, ‹ › or `Enter` / `Shift+Enter` to step, every hit in `yaml-match` and the current one in `yaml-match-current`. Plain ← → can't be the step keys while you're typing in the find box, because they move the text cursor.

### Pop-out windows

- **⧉ in a tab's toolbar**, or **dragging a tab outside the editor**, opens that tab in its own window. Dragging a tab onto the other split moves it there instead.
- A pop-out window is **bound to the context it came from**. Switching contexts in the main window doesn't change it. Its title bar repeats the env chip, the 2px env strip and the short name, so a floating prod window still reads as prod.
- Each window has its own find bar and Describe │ YAML switch, and a **dock** button that sends the tab back to the main editor (switching the main window to that context if needed).
- Pop-out windows aren't saved. They close with the app, in line with "nothing stored".
- **Implementation:** this needs **Wails v3**, which supports multiple native windows (currently in beta). Wails v2 is single-window: there, the fallback is an in-app floating panel, which is what the mockup shows.

## Where do resources get listed? Two options

**Option A: resource tree in the right nav.** Expanding a type in the nav lists its resources under it. Clicking one opens it in the middle (Describe first). The middle only holds resource views.
- *Good:* one click from type to YAML, and the middle stays a pure editor. The name filter (`widget-2`) jumps straight to the resource.
- *Costs:* a 312px column can't show status, restarts, age or node, so you're choosing from names alone. Long pod names get truncated, and big lists (500 pods) turn the nav into a scroll fight.

**Option B: resource table in the middle.** Clicking a type opens a *list tab* in the middle: a table with Name, Status, Ready, Restarts, Age, Namespace and Node, with its own name filter. Clicking a row opens the resource in the *other* editor group when split (list left, Describe / YAML right), otherwise in the same group.
- *Good:* during an incident the table tells you *which* pod before you open anything (the red dot, 14 restarts). It scales to big lists, and list tabs are tabs like any other, so you can keep `Pods` and `Widgets` side by side.
- *Costs:* one more click to reach a resource, and the split is doing a lot of the work.

**Recommendation: B**, with the right nav exactly as specified (namespace, filter, categories with counts). Borrow one piece of A: type a resource name into the nav filter and get a small "Resources" result block at the top that opens the resource directly.

## Data model (for the Go side)

- `Contexts()`: parses the kubeconfig and returns `{name, short, where, env, cluster, user, namespace}`. Re-reads when the file changes. Never writes to it.
- `Discover(ctx)`: discovery, then `[]{group, version, kind, plural, namespaced, shortNames, isCRD}`.
- `List(ctx, gvr, ns)` / `Watch(…)`: informers per open list, stopped when the tab closes.
- `Get(ctx, gvr, ns, name)`: returns YAML with `managedFields` stripped.
- `Describe(ctx, gvr, ns, name)`: returns `kubectl describe` text via `k8s.io/kubectl/pkg/describe`.
- `OpenWindow(ctx, tabRef)`: Wails v3 multi-window, one window per popped tab, bound to its context.
- "Active context" is **in-app only**. Kompass never runs `kubectl config use-context` and never changes `current-context`, so your terminal stays where you left it.

## Open questions

1. **Active context:** should "sets it as the active k8s context" also change `current-context` for your terminal? The mockups assume *no* (app-only), which is safer mid-incident.
2. **Rail across restarts:** with "no locally stored values", the open-contexts rail resets every launch. Is that okay, or is a context-*names*-only list on disk acceptable?
3. **Secrets:** masked with per-key reveal, or never shown at all?
4. **Widget CRD group:** the mockups use `example.com` as a placeholder. Swap in the real group (and whether `WidgetNamespace` is cluster-scoped).
5. **StatefulSets** were missing from the Workloads list in the brief and have been added.
6. **Wails version:** pop-out windows need Wails v3 (multi-window, in beta). Is building on v3 okay, or should v1 stay on v2 with in-app floating panels?

## Foundations

- **Colour:** neutral graphite surfaces (`bg-000`–`bg-300`) with hairlines (`line`): borders, not shadows. One accent (`accent`, teal) for focus and selection. Environment colours are reserved for environments and status colours for status, and the accent is never used for an environment.
- **Type:** Inter for the interface, JetBrains Mono for everything that came from the cluster (names, namespaces, YAML, counts). If it came from the API server, it's mono.
- **Density:** 28px rows (`row-height`), 13px body, 12.5px code. Dense enough for a 500-pod list, roomy enough to click under pressure.
- **Themes:** Dark first, Light second. Both pass 4.5:1 for `ink` and `ink-muted` on every surface. `ink-faint` is for line numbers and disabled rows only.
