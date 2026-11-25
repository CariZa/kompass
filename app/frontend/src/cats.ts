// Built-in categories, in spec order except Events, which sits under Nodes
// so it's one click away during an incident. Each entry is a type key
// ("<group or core>/<Kind>") plus a label; discovery decides which exist.
export interface Type {
  key: string; group: string; version: string; kind: string; plural: string;
  namespaced: boolean; shortNames: string[] | null; isCRD: boolean;
}

export interface NavType {
  key: string; label: string; kind: string; group: string; short: string[];
  namespaced: boolean; pseudo?: 'overview' | 'disabled' | 'helm'; note?: string;
}

export interface Cat { name: string; flat?: boolean; types: NavType[]; sub?: { name: string; types: NavType[] }[] }

export const HELM_KEY = 'helm.sh/HelmRelease';

type B = [label: string, key: string, short?: string[]];
const BUILTIN: { name: string; flat?: boolean; types: B[] }[] = [
  { name: 'Nodes', flat: true, types: [['Nodes', 'core/Node', ['no']]] },
  { name: 'Events', flat: true, types: [['Events', 'core/Event', ['ev']]] },
  { name: 'Workloads', types: [['Overview', 'pseudo/Overview'], ['Pods', 'core/Pod', ['po']], ['Deployments', 'apps/Deployment', ['deploy']], ['StatefulSets', 'apps/StatefulSet', ['sts']], ['DaemonSets', 'apps/DaemonSet', ['ds']], ['ReplicaSets', 'apps/ReplicaSet', ['rs']], ['Replication Controllers', 'core/ReplicationController', ['rc']], ['Jobs', 'batch/Job'], ['CronJobs', 'batch/CronJob', ['cj']]] },
  { name: 'Config', types: [['ConfigMaps', 'core/ConfigMap', ['cm']], ['Secrets', 'core/Secret'], ['Resource Quotas', 'core/ResourceQuota', ['quota']], ['Limit Ranges', 'core/LimitRange', ['limits']], ['HPA', 'autoscaling/HorizontalPodAutoscaler', ['hpa']], ['Pod Disruption Budgets', 'policy/PodDisruptionBudget', ['pdb']], ['Priority Classes', 'scheduling.k8s.io/PriorityClass', ['pc']], ['Runtime Classes', 'node.k8s.io/RuntimeClass'], ['Leases', 'coordination.k8s.io/Lease'], ['Mutating Webhook Configs', 'admissionregistration.k8s.io/MutatingWebhookConfiguration'], ['Validating Webhook Configs', 'admissionregistration.k8s.io/ValidatingWebhookConfiguration']] },
  { name: 'Network', types: [['Services', 'core/Service', ['svc']], ['Endpoints', 'core/Endpoints', ['ep']], ['Endpoint Slices', 'discovery.k8s.io/EndpointSlice'], ['Ingresses', 'networking.k8s.io/Ingress', ['ing']], ['Ingress Classes', 'networking.k8s.io/IngressClass'], ['Network Policies', 'networking.k8s.io/NetworkPolicy', ['netpol']], ['Port Forwarding', 'pseudo/PortForward']] },
  { name: 'Storage', types: [['Persistent Volume Claims', 'core/PersistentVolumeClaim', ['pvc']], ['Persistent Volumes', 'core/PersistentVolume', ['pv']], ['Storage Classes', 'storage.k8s.io/StorageClass', ['sc']]] },
  { name: 'Namespaces', flat: true, types: [['Namespaces', 'core/Namespace', ['ns']]] },
  { name: 'Helm', types: [['Releases', HELM_KEY, ['helm']]] },
  { name: 'Access Control', types: [['Service Accounts', 'core/ServiceAccount', ['sa']], ['Cluster Roles', 'rbac.authorization.k8s.io/ClusterRole'], ['Roles', 'rbac.authorization.k8s.io/Role'], ['Cluster Role Bindings', 'rbac.authorization.k8s.io/ClusterRoleBinding', ['crb']], ['Role Bindings', 'rbac.authorization.k8s.io/RoleBinding', ['rb']]] },
];

// The same kind served by a second API group shouldn't show twice.
const DUPLICATES = new Set(['events.k8s.io/Event']);

// splitCamel turns "PriorityLevelConfiguration" into "Priority Level Configurations".
function labelFor(t: Type): string {
  const words = t.kind.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return /s$/.test(words) ? words : /y$/.test(words) ? words.slice(0, -1) + 'ies' : words + 's';
}

function navType(t: Type, label?: string, short?: string[]): NavType {
  return { key: t.key, label: label ?? labelFor(t), kind: t.kind, group: t.group, namespaced: t.namespaced,
    short: [...new Set([...(short || []), ...(t.shortNames || [])])] };
}

// buildCats places every discovered type: built-ins in their category, CRD
// kinds under Custom Resources by API group, the rest under Uncategorized.
export function buildCats(types: Type[]): { cats: Cat[]; all: Record<string, NavType> } {
  const byKey: Record<string, Type> = {};
  types.forEach((t) => (byKey[t.key] = t));
  const used = new Set<string>();
  const all: Record<string, NavType> = {};
  const cats: Cat[] = BUILTIN.map((c) => ({
    name: c.name, flat: c.flat,
    types: c.types.flatMap(([label, key, short]): NavType[] => {
      if (key === 'pseudo/Overview') return [{ key, label, kind: 'Overview', group: '', short: ['overview', 'workloads'], namespaced: false, pseudo: 'overview' }];
      if (key === 'pseudo/PortForward') return [{ key, label, kind: 'PortForward', group: '', short: ['pf'], namespaced: false, pseudo: 'disabled', note: 'v2 · needs write' }];
      if (key === HELM_KEY) return byKey['core/Secret'] ? [{ key, label, kind: 'HelmRelease', group: 'helm.sh', short: short || [], namespaced: true, pseudo: 'helm' }] : [];
      const t = byKey[key];
      if (!t) return [];
      used.add(key);
      return [navType(t, label, short)];
    }),
  }));
  const groups: Record<string, NavType[]> = {};
  const uncategorized: NavType[] = [];
  let crdDefs: NavType | null = null;
  types.forEach((t) => {
    if (used.has(t.key) || DUPLICATES.has(t.key)) return;
    if (t.key === 'apiextensions.k8s.io/CustomResourceDefinition') { crdDefs = navType(t, 'Definitions', ['crd', 'crds']); return; }
    if (t.isCRD) (groups[t.group] ||= []).push(navType(t));
    else uncategorized.push(navType(t));
  });
  const sub = Object.keys(groups).sort().map((g) => ({ name: g, types: groups[g].sort((a, b) => a.label.localeCompare(b.label)) }));
  cats.push({ name: 'Custom Resources', types: crdDefs ? [crdDefs] : [], sub });
  cats.push({ name: 'Uncategorized', types: uncategorized.sort((a, b) => a.label.localeCompare(b.label)) });
  cats.forEach((c) => { c.types.forEach((t) => (all[t.key] = t)); c.sub?.forEach((s) => s.types.forEach((t) => (all[t.key] = t))); });
  return { cats, all };
}

export function catTypes(c: Cat): NavType[] {
  return c.types.concat(...(c.sub || []).map((s) => s.types));
}

// Short labels for tab headers.
export const ABBR: Record<string, string> = {
  Pod: 'po', Deployment: 'deploy', StatefulSet: 'sts', DaemonSet: 'ds', ReplicaSet: 'rs', Service: 'svc', ConfigMap: 'cm',
  Secret: 'secret', Node: 'no', Namespace: 'ns', PersistentVolumeClaim: 'pvc', PersistentVolume: 'pv', Ingress: 'ing',
  Event: 'ev', Job: 'job', CronJob: 'cj', ServiceAccount: 'sa', HelmRelease: 'helm', CustomResourceDefinition: 'crd',
};
