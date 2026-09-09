/**
 * Sing-box Configuration
 *
 * First-generation compatibility template:
 *
 *   - sing-box 1.11 legacy
 *   - sing-box 1.12 transitional
 *   - sing-box 1.14+ modern schema
 *
 * Important:
 *   Do NOT add `dns.enable`.
 *   Do NOT use legacy `dns.fakeip` on 1.14+.
 *   Do NOT use `independent_cache` on 1.14+.
 *   Do NOT use `download_detour` on 1.14+.
 */

export const SING_BOX_CONFIG = {
	dns: {
		servers: [
			{
				type: "https",
				tag: "dns_proxy",
				server: "1.1.1.1",
				path: "/dns-query",
				detour: "🚀 节点选择",
				domain_resolver: "dns_resolver"
			},
			{
				type: "https",
				tag: "dns_direct",
				server: "dns.alidns.com",
				path: "/dns-query",
				domain_resolver: "dns_resolver"
			},
			{
				type: "udp",
				tag: "dns_resolver",
				server: "223.5.5.5"
			},
			{
				type: "fakeip",
				tag: "dns_fakeip",
				inet4_range: "198.18.0.0/15",
				inet6_range: "fc00::/18"
			}
		],

		rules: [
			{
				rule_set: "geolocation-!cn",
				query_type: [
					"A",
					"AAAA"
				],
				server: "dns_fakeip"
			},
			{
				rule_set: "geolocation-!cn",
				query_type: "CNAME",
				server: "dns_proxy"
			},
			{
				query_type: [
					"A",
					"AAAA",
					"CNAME"
				],
				invert: true,
				action: "predefined",
				rcode: "REFUSED"
			}
		],

		/*
		 * The final DNS server is kept explicit.
		 *
		 * If privacy/no-DNS-leak mode is desired, the builder can
		 * replace this with dns_proxy.
		 */
		final: "dns_direct"
	},

	ntp: {
		enabled: true,
		server: "time.apple.com",
		server_port: 123,
		interval: "30m"
	},

	inbounds: [
		{
			type: "mixed",
			tag: "mixed-in",
			listen: "0.0.0.0",
			listen_port: 2080
		},

		{
			type: "tun",
			tag: "tun-in",

			/*
			 * sing-box 1.10+ uses `address`.
			 * Do NOT use inet4_address / inet6_address.
			 */
			address: [
				"172.19.0.1/30",
				"fdfe:dcba:9876::1/126"
			],

			auto_route: true,
			strict_route: true,
			stack: "mixed"
		}
	],

	outbounds: [
		{
			type: "direct",
			tag: "DIRECT"
		}
	],

	route: {
		default_domain_resolver: "dns_resolver",

		rule_set: [
			{
				tag: "geosite-geolocation-!cn",
				type: "local",
				format: "binary",
				path: "geosite-geolocation-!cn.srs"
			}
		],

		rules: []
	},

	experimental: {
		cache_file: {
			enabled: true,

			/*
			 * FakeIP cache is supported by the modern DNS fakeip
			 * server model.
			 */
			store_fakeip: true
		}
	}
};


/*
 * Legacy configuration for sing-box 1.11.
 *
 * This is intentionally kept separate from SING_BOX_CONFIG.
 *
 * DO NOT use this object for 1.14+.
 */
export const SING_BOX_CONFIG_V1_11 = {
	dns: {
		servers: [
			{
				tag: "dns_proxy",
				address: "tls://1.1.1.1",
				detour: "🚀 节点选择"
			},

			{
				tag: "dns_direct",
				address: "https://dns.alidns.com/dns-query",
				detour: "DIRECT",
				address_resolver: "dns_resolver"
			},

			{
				tag: "dns_resolver",
				address: "223.5.5.5",
				detour: "DIRECT"
			},

			{
				tag: "dns_fakeip",
				address: "fakeip"
			}
		],

		rules: [
			{
				rule_set: "geolocation-!cn",
				query_type: [
					"A",
					"AAAA"
				],
				server: "dns_fakeip"
			},

			{
				rule_set: "geolocation-!cn",
				query_type: "CNAME",
				server: "dns_proxy"
			},

			{
				query_type: [
					"A",
					"AAAA",
					"CNAME"
				],
				invert: true,
				server: "dns_direct",
				disable_cache: true
			}
		],

		final: "dns_direct",
		strategy: "prefer_ipv4",

		/*
		 * Kept ONLY for 1.11.
		 */
		independent_cache: true,

		fakeip: {
			enabled: true,
			inet4_range: "198.18.0.0/15",
			inet6_range: "fc00::/18"
		}
	},

	ntp: {
		enabled: true,
		server: "time.apple.com",
		server_port: 123,
		interval: "30m"
	},

	inbounds: [
		{
			type: "mixed",
			tag: "mixed-in",
			listen: "0.0.0.0",
			listen_port: 2080
		},

		{
			type: "tun",
			tag: "tun-in",
			address: "172.19.0.1/30",
			auto_route: true,
			strict_route: true,
			stack: "mixed"
		}
	],

	outbounds: [
		{
			type: "direct",
			tag: "DIRECT"
		}
	],

	route: {
		rule_set: [],
		rules: []
	},

	experimental: {
		cache_file: {
			enabled: true,
			store_fakeip: true
		}
	}
};
