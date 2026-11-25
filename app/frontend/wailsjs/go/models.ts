export namespace kube {
	
	export class Addon {
	    category: string;
	    name: string;
	    version: string;
	    namespace: string;
	    workload: string;
	    image: string;
	
	    static createFrom(source: any = {}) {
	        return new Addon(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.category = source["category"];
	        this.name = source["name"];
	        this.version = source["version"];
	        this.namespace = source["namespace"];
	        this.workload = source["workload"];
	        this.image = source["image"];
	    }
	}
	export class NodeGroup {
	    provisioner: string;
	    pool: string;
	    instanceType: string;
	    capacity: string;
	    arch: string;
	    osImage: string;
	    kernels: string;
	    imageId: string;
	    nodes: number;
	
	    static createFrom(source: any = {}) {
	        return new NodeGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.provisioner = source["provisioner"];
	        this.pool = source["pool"];
	        this.instanceType = source["instanceType"];
	        this.capacity = source["capacity"];
	        this.arch = source["arch"];
	        this.osImage = source["osImage"];
	        this.kernels = source["kernels"];
	        this.imageId = source["imageId"];
	        this.nodes = source["nodes"];
	    }
	}
	export class KubeletVersion {
	    version: string;
	    nodes: number;
	
	    static createFrom(source: any = {}) {
	        return new KubeletVersion(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.nodes = source["nodes"];
	    }
	}
	export class ClusterDetails {
	    addons: Addon[];
	    kubelets: KubeletVersion[];
	    nodeGroups: NodeGroup[];
	    errors?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ClusterDetails(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.addons = this.convertValues(source["addons"], Addon);
	        this.kubelets = this.convertValues(source["kubelets"], KubeletVersion);
	        this.nodeGroups = this.convertValues(source["nodeGroups"], NodeGroup);
	        this.errors = source["errors"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ClusterInfo {
	    server: string;
	    version: string;
	    platform: string;
	    auth: string;
	    typeCount: number;
	    crdCount: number;
	    groupCount: number;
	
	    static createFrom(source: any = {}) {
	        return new ClusterInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.server = source["server"];
	        this.version = source["version"];
	        this.platform = source["platform"];
	        this.auth = source["auth"];
	        this.typeCount = source["typeCount"];
	        this.crdCount = source["crdCount"];
	        this.groupCount = source["groupCount"];
	    }
	}
	export class ContainerInfo {
	    name: string;
	    kind: string;
	    default: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ContainerInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.default = source["default"];
	    }
	}
	export class Context {
	    name: string;
	    short: string;
	    where: string;
	    env: string;
	    provider: string;
	    cluster: string;
	    user: string;
	    namespace: string;
	    server: string;
	
	    static createFrom(source: any = {}) {
	        return new Context(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.short = source["short"];
	        this.where = source["where"];
	        this.env = source["env"];
	        this.provider = source["provider"];
	        this.cluster = source["cluster"];
	        this.user = source["user"];
	        this.namespace = source["namespace"];
	        this.server = source["server"];
	    }
	}
	
	
	export class Type {
	    key: string;
	    group: string;
	    version: string;
	    kind: string;
	    plural: string;
	    namespaced: boolean;
	    shortNames: string[];
	    isCRD: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Type(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.group = source["group"];
	        this.version = source["version"];
	        this.kind = source["kind"];
	        this.plural = source["plural"];
	        this.namespaced = source["namespaced"];
	        this.shortNames = source["shortNames"];
	        this.isCRD = source["isCRD"];
	    }
	}

}

export namespace main {
	
	export class Connected {
	    types: kube.Type[];
	    namespaces: string[];
	    nsError?: string;
	
	    static createFrom(source: any = {}) {
	        return new Connected(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.types = this.convertValues(source["types"], kube.Type);
	        this.namespaces = source["namespaces"];
	        this.nsError = source["nsError"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

