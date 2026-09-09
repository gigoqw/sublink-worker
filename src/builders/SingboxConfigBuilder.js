import {
    SING_BOX_CONFIG,
    generateRuleSets,
    generateRules,
    getOutbounds,
    PREDEFINED_RULE_SETS,
    DIRECT_DEFAULT_RULES,
    REJECT_ACTION_RULES
} from '../config/index.js';

import { BaseConfigBuilder } from './BaseConfigBuilder.js';
import { deepCopy, groupProxiesByCountry } from '../utils.js';
import { addProxyWithDedup } from './helpers/proxyHelpers.js';
import {
    buildSelectorMembers as buildSelectorMemberList,
    buildNodeSelectMembers,
    buildCustomRuleMembers,
    uniqueNames
} from './helpers/groupBuilder.js';
import { normalizeGroupName } from './helpers/groupNameUtils.js';

const RULE_SET_HTTP_CLIENT_TAG = 'rule-set-download';

/**
 * Parse Sing-box version safely.
 *
 * Supports:
 *   1.11
 *   1.12
 *   1.13
 *   1.14
 *   1.14.1
 *   1.15
 *   1.16+
 */
function parseSingboxVersion(version) {
    const match = String(version || '')
        .trim()
        .match(/^(\d+)\.(\d+)(?:\.(\d+))?/);

    if (!match) {
        return {
            major: 1,
            minor: 12,
            patch: 0
        };
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3] || 0)
    };
}

function isSingboxVersionAtLeast(version, major, minor) {
    const parsed = parseSingboxVersion(version);

    if (parsed.major !== major) {
        return parsed.major > major;
    }

    return parsed.minor >= minor;
}

export class SingboxConfigBuilder extends BaseConfigBuilder {
    constructor(
        inputString,
        selectedRules,
        customRules,
        baseConfig,
        lang,
        userAgent,
        groupByCountry = false,
        enableClashUI = false,
        externalController,
        externalUiDownloadUrl,
        singboxVersion = '1.12',
        includeAutoSelect = true
    ) {
        const resolvedBaseConfig = baseConfig ?? SING_BOX_CONFIG;

        super(
            inputString,
            resolvedBaseConfig,
            lang,
            userAgent,
            groupByCountry,
            includeAutoSelect
        );

        this.selectedRules = selectedRules;
        this.customRules = customRules;
        this.countryGroupNames = [];
        this.manualGroupName = null;

        this.enableClashUI = enableClashUI;
        this.externalController = externalController;
        this.externalUiDownloadUrl = externalUiDownloadUrl;

        this.singboxVersion = String(singboxVersion || '1.12').trim();

        this.singboxIs112OrNewer =
            isSingboxVersionAtLeast(this.singboxVersion, 1, 12);

        this.singboxIs114OrNewer =
            isSingboxVersionAtLeast(this.singboxVersion, 1, 14);

        if (this.config?.dns?.servers?.length > 0) {
            this.config.dns.servers[0].detour =
                this.t('outboundNames.Node Select');
        }
    }

    /**
     * Check if subscription format is compatible for use as
     * Sing-Box outbound_provider.
     *
     * outbound_providers are available from Sing-box 1.12+.
     */
    isCompatibleProviderFormat(format) {
        return this.singboxIs112OrNewer && format === 'singbox';
    }

    /**
     * Generate outbound_providers configuration from collected URLs.
     */
    generateOutboundProviders() {
        const existingTags = this.getExistingProviderTags();

        return this.getAutoProviderDescriptors(existingTags).map(
            ({ name, url }) => ({
                tag: name,
                type: 'http',
                download_url: url,
                path: `./providers/${name}.json`,
                download_interval: '24h',
                health_check: {
                    enabled: true,
                    url: 'https://www.gstatic.com/generate_204',
                    interval: '5m'
                }
            })
        );
    }

    /**
     * Get list of provider tags.
     */
    getProviderTags() {
        return this.getAutoProviderDescriptors(
            this.getExistingProviderTags()
        ).map(provider => provider.name);
    }

    getExistingProviderTags() {
        return Array.isArray(this.config.outbound_providers)
            ? this.config.outbound_providers
                .map(p => p?.tag)
                .filter(Boolean)
            : [];
    }

    /**
     * Get all provider tags.
     */
    getAllProviderTags() {
        if (!this.singboxIs112OrNewer) {
            return [];
        }

        const existingTags = this.getExistingProviderTags();
        const autoTags = this.getProviderTags();

        return [...new Set([
            ...existingTags,
            ...autoTags
        ])];
    }

    getProxies() {
        return this.config.outbounds.filter(
            outbound => outbound?.server != undefined
        );
    }

    getProxyName(proxy) {
        return proxy.tag;
    }

    convertProxy(proxy) {
        // Create a shallow copy to avoid mutating the original.
        const sanitized = { ...proxy };

        /*
         * Clash-only / incompatible fields.
         */
        delete sanitized.udp;
        delete sanitized.network;

        /*
         * In Sing-box, ALPN belongs inside TLS.
         */
        if (sanitized.alpn && sanitized.tls) {
            if (!sanitized.tls.alpn) {
                sanitized.tls = {
                    ...sanitized.tls,
                    alpn: sanitized.alpn
                };
            }

            delete sanitized.alpn;
        } else if (sanitized.alpn && !sanitized.tls) {
            delete sanitized.alpn;
        }

        /*
         * packet_encoding is version-specific.
         * Newer Sing-box versions handle the modern default.
         */
        delete sanitized.packet_encoding;

        return sanitized;
    }

    addProxyToConfig(proxy) {
        this.config.outbounds = this.config.outbounds || [];

        addProxyWithDedup(
            this.config.outbounds,
            proxy,
            {
                getName: item => item?.tag,

                setName: (item, name) => {
                    if (item) item.tag = name;
                },

                isSame: (existing = {}, incoming = {}) => {
                    const {
                        tag: _incomingTag,
                        ...restIncoming
                    } = incoming;

                    const {
                        tag: _existingTag,
                        ...restExisting
                    } = existing;

                    return JSON.stringify(restIncoming) ===
                        JSON.stringify(restExisting);
                }
            }
        );
    }

    hasOutboundTag(tag) {
        const target = normalizeGroupName(tag);

        return (this.config.outbounds || []).some(
            outbound =>
                normalizeGroupName(outbound?.tag) === target
        );
    }

    hasAutoSelectCandidates(proxyList = this.getProxyList()) {
        return (
            Array.isArray(proxyList) &&
            proxyList.length > 0
        ) || this.getAllProviderTags().length > 0;
    }

    addAutoSelectGroup(proxyList) {
        if (!this.includeAutoSelect) return;

        this.config.outbounds =
            this.config.outbounds || [];

        const tag =
            this.t('outboundNames.Auto Select');

        if (this.hasOutboundTag(tag)) return;

        const providerTags =
            this.getAllProviderTags();

        const autoSelectMembers =
            deepCopy(uniqueNames(proxyList));

        if (
            autoSelectMembers.length === 0 &&
            providerTags.length === 0
        ) {
            return;
        }

        const group = {
            type: 'urltest',
            tag,
            outbounds: autoSelectMembers
        };

        if (providerTags.length > 0) {
            group.providers = providerTags;
        }

        this.config.outbounds.unshift(group);
    }

    addNodeSelectGroup(proxyList) {
        this.config.outbounds =
            this.config.outbounds || [];

        const tag =
            this.t('outboundNames.Node Select');

        if (this.hasOutboundTag(tag)) return;

        const includeAutoSelect =
            this.includeAutoSelect &&
            this.hasAutoSelectCandidates(proxyList);

        const members = buildNodeSelectMembers({
            proxyList,
            translator: this.t,
            groupByCountry: this.groupByCountry,
            manualGroupName: this.manualGroupName,
            countryGroupNames: this.countryGroupNames,
            includeAutoSelect,
            includeReject: false
        });

        const group = {
            type: 'selector',
            tag,
            outbounds: members
        };

        const providerTags =
            this.getAllProviderTags();

        if (providerTags.length > 0) {
            group.providers = providerTags;
        }

        this.config.outbounds.unshift(group);
    }

    buildSelectorMembers(proxyList = []) {
        return buildSelectorMemberList({
            proxyList,
            translator: this.t,
            groupByCountry: this.groupByCountry,
            manualGroupName: this.manualGroupName,
            countryGroupNames: this.countryGroupNames,
            includeAutoSelect:
                this.includeAutoSelect &&
                this.hasAutoSelectCandidates(proxyList),
            includeReject: false
        });
    }

    addOutboundGroups(outbounds, proxyList) {
        outbounds.forEach(outbound => {
            if (
                outbound !==
                this.t('outboundNames.Node Select')
            ) {
                if (REJECT_ACTION_RULES.has(outbound)) {
                    return;
                }

                let selectorMembers =
                    this.buildSelectorMembers(proxyList);

                const tag =
                    this.t(`outboundNames.${outbound}`);

                if (this.hasOutboundTag(tag)) {
                    return;
                }

                if (DIRECT_DEFAULT_RULES.has(outbound)) {
                    selectorMembers = [
                        'DIRECT',
                        ...selectorMembers.filter(
                            p => p !== 'DIRECT'
                        )
                    ];
                }

                this.config.outbounds.push({
                    type: 'selector',
                    tag,
                    outbounds: selectorMembers
                });
            }
        });
    }

    addCustomRuleGroups(proxyList) {
        if (!Array.isArray(this.customRules)) {
            return;
        }

        this.customRules.forEach(rule => {
            const includeAutoSelect =
                this.includeAutoSelect &&
                this.hasAutoSelectCandidates(proxyList);

            const selectorMembers =
                buildCustomRuleMembers({
                    proxyList,
                    translator: this.t,
                    manualGroupName: this.manualGroupName,
                    includeAutoSelect,
                    includeReject: false
                });

            if (this.hasOutboundTag(rule.name)) {
                return;
            }

            this.config.outbounds.push({
                type: 'selector',
                tag: rule.name,
                outbounds: selectorMembers
            });
        });
    }

    addFallBackGroup(proxyList) {
        const selectorMembers =
            this.buildSelectorMembers(proxyList);

        if (
            this.hasOutboundTag(
                this.t('outboundNames.Fall Back')
            )
        ) {
            return;
        }

        this.config.outbounds.push({
            type: 'selector',
            tag: this.t('outboundNames.Fall Back'),
            outbounds: selectorMembers
        });
    }

    addCountryGroups() {
        const proxies = this.getProxies();

        const countryGroups =
            groupProxiesByCountry(proxies, {
                getName: proxy => this.getProxyName(proxy)
            });

        const existingTags = new Set(
            (this.config.outbounds || [])
                .map(o =>
                    normalizeGroupName(o?.tag)
                )
                .filter(Boolean)
        );

        const manualProxyNames =
            proxies
                .map(p => p?.tag)
                .filter(Boolean);

        const manualGroupName =
            manualProxyNames.length > 0
                ? this.t('outboundNames.Manual Switch')
                : null;

        if (manualGroupName) {
            const manualNorm =
                normalizeGroupName(manualGroupName);

            if (!existingTags.has(manualNorm)) {
                this.config.outbounds.push({
                    type: 'selector',
                    tag: manualGroupName,
                    outbounds: manualProxyNames
                });

                existingTags.add(manualNorm);
            }
        }

        const countries =
            Object.keys(countryGroups)
                .sort((a, b) => a.localeCompare(b));

        const countryGroupNames = [];

        const includeAutoSelect =
            this.includeAutoSelect &&
            this.hasAutoSelectCandidates();

        countries.forEach(country => {
            const {
                emoji,
                name,
                proxies: countryProxies
            } = countryGroups[country];

            if (
                !countryProxies ||
                countryProxies.length === 0
            ) {
                return;
            }

            const groupName =
                `${emoji} ${name}`;

            const norm =
                normalizeGroupName(groupName);

            if (!existingTags.has(norm)) {
                this.config.outbounds.push({
                    tag: groupName,
                    type: 'urltest',
                    outbounds: countryProxies
                });

                existingTags.add(norm);
            }

            countryGroupNames.push(groupName);
        });

        const nodeSelectTag =
            this.t('outboundNames.Node Select');

        const nodeSelectGroup =
            this.config.outbounds.find(
                o =>
                    normalizeGroupName(o?.tag) ===
                    normalizeGroupName(nodeSelectTag)
            );

        if (
            nodeSelectGroup &&
            Array.isArray(nodeSelectGroup.outbounds)
        ) {
            const rebuilt =
                buildNodeSelectMembers({
                    proxyList: [],
                    translator: this.t,
                    groupByCountry: true,
                    manualGroupName,
                    countryGroupNames,
                    includeAutoSelect,
                    includeReject: false
                });

            nodeSelectGroup.outbounds = rebuilt;
        }

        this.countryGroupNames =
            countryGroupNames;

        this.manualGroupName =
            manualGroupName;
    }

    /**
     * Merge user-defined proxy groups.
     */
    mergeUserProxyGroups(userGroups) {
        if (!Array.isArray(userGroups)) return;

        const proxyList =
            this.getProxyList();

        const validProxyTags =
            new Set(proxyList);

        const allProviderTags =
            new Set(this.getAllProviderTags());

        const groupTags = new Set(
            (this.config.outbounds || [])
                .filter(
                    o =>
                        o.type === 'selector' ||
                        o.type === 'urltest'
                )
                .map(o =>
                    normalizeGroupName(o?.tag)
                )
                .filter(Boolean)
        );

        const validRefs =
            new Set(['DIRECT', 'direct']);

        proxyList.forEach(
            n => validRefs.add(n)
        );

        groupTags.forEach(
            n => validRefs.add(n)
        );

        userGroups.forEach(userGroup => {
            if (!userGroup?.name) return;

            const existingIndex =
                (this.config.outbounds || [])
                    .findIndex(
                        o =>
                            normalizeGroupName(o?.tag) ===
                            normalizeGroupName(userGroup.name)
                    );

            if (existingIndex >= 0) {
                const existing =
                    this.config.outbounds[existingIndex];

                if (
                    Array.isArray(userGroup.use) &&
                    userGroup.use.length > 0
                ) {
                    const validUserProviders =
                        userGroup.use.filter(
                            p => allProviderTags.has(p)
                        );

                    existing.providers = [
                        ...(existing.providers || []),
                        ...validUserProviders
                    ];

                    existing.providers =
                        [...new Set(existing.providers)];
                }

                if (
                    Array.isArray(userGroup.proxies) &&
                    userGroup.proxies.length > 0
                ) {
                    const validUserOutbounds =
                        userGroup.proxies.filter(
                            p => validRefs.has(p)
                        );

                    existing.outbounds = [
                        ...(existing.outbounds || []),
                        ...validUserOutbounds
                    ];

                    existing.outbounds =
                        [...new Set(existing.outbounds)];
                }

                if (userGroup.url) {
                    existing.url = userGroup.url;
                }

                if (
                    typeof userGroup.interval ===
                    'number'
                ) {
                    existing.interval =
                        `${userGroup.interval}s`;
                }
            } else {
                const newOutbound = {
                    type:
                        userGroup.type === 'url-test'
                            ? 'urltest'
                            : 'selector',
                    tag: userGroup.name
                };

                if (
                    Array.isArray(
                        userGroup.proxies
                    )
                ) {
                    newOutbound.outbounds =
                        userGroup.proxies.filter(
                            p => validRefs.has(p)
                        );
                }

                if (
                    Array.isArray(userGroup.use)
                ) {
                    const validProviders =
                        userGroup.use.filter(
                            p =>
                                allProviderTags.has(p)
                        );

                    if (
                        validProviders.length > 0
                    ) {
                        newOutbound.providers =
                            validProviders;
                    }
                }

                if (
                    (newOutbound.outbounds?.length > 0) ||
                    (newOutbound.providers?.length > 0)
                ) {
                    this.config.outbounds.push(
                        newOutbound
                    );
                }
            }
        });
    }

    /**
     * Validate outbounds before final output.
     */
    validateOutbounds() {
        const proxyList =
            this.getProxyList();

        const providerTags =
            this.getAllProviderTags();

        const invalidTags =
            new Set();

        (this.config.outbounds || [])
            .forEach(outbound => {
                if (
                    outbound.type === 'urltest' &&
                    (!outbound.outbounds ||
                        outbound.outbounds.length === 0) &&
                    (!outbound.providers ||
                        outbound.providers.length === 0)
                ) {
                    outbound.outbounds =
                        [...proxyList];

                    if (providerTags.length > 0) {
                        outbound.providers =
                            [...providerTags];
                    }

                    if (
                        (!outbound.outbounds ||
                            outbound.outbounds.length === 0) &&
                        (!outbound.providers ||
                            outbound.providers.length === 0)
                    ) {
                        invalidTags.add(
                            normalizeGroupName(
                                outbound.tag
                            )
                        );
                    }
                }
            });

        if (invalidTags.size > 0) {
            this.config.outbounds =
                (this.config.outbounds || [])
                    .filter(
                        outbound =>
                            !invalidTags.has(
                                normalizeGroupName(
                                    outbound?.tag
                                )
                            )
                    )
                    .map(outbound => {
                        if (
                            Array.isArray(
                                outbound.outbounds
                            )
                        ) {
                            outbound.outbounds =
                                outbound.outbounds.filter(
                                    tag =>
                                        !invalidTags.has(
                                            normalizeGroupName(
                                                tag
                                            )
                                        )
                                );
                        }

                        return outbound;
                    });
        }
    }

    sanitizeLegacySpecialOutbounds() {
        const legacyTags =
            new Set(
                (this.config.outbounds || [])
                    .filter(
                        outbound =>
                            outbound?.type === 'block' ||
                            outbound?.type === 'dns'
                    )
                    .map(outbound =>
                        normalizeGroupName(
                            outbound?.tag
                        )
                    )
                    .filter(Boolean)
            );

        legacyTags.add(
            normalizeGroupName('REJECT')
        );

        this.config.outbounds =
            (this.config.outbounds || [])
                .filter(
                    outbound =>
                        !legacyTags.has(
                            normalizeGroupName(
                                outbound?.tag
                            )
                        )
                )
                .map(outbound => {
                    if (
                        Array.isArray(
                            outbound.outbounds
                        )
                    ) {
                        outbound.outbounds =
                            outbound.outbounds.filter(
                                tag =>
                                    !legacyTags.has(
                                        normalizeGroupName(
                                            tag
                                        )
                                    )
                            );
                    }

                    return outbound;
                })
                .filter(outbound => {
                    if (
                        outbound?.type !== 'selector' &&
                        outbound?.type !== 'urltest'
                    ) {
                        return true;
                    }

                    return (
                        outbound.outbounds?.length > 0 ||
                        outbound.providers?.length > 0
                    );
                });
    }

    /**
     * Remove fields that are no longer valid on modern
     * Sing-box versions.
     *
     * IMPORTANT:
     * We intentionally do NOT globally delete `enabled`.
     * `enabled` is still valid for several Sing-box objects.
     */
    sanitizeModernSingboxConfig() {
        if (!this.config) {
            return;
        }

        /*
         * Your current reported error:
         *
         * decode config: dns.enable:
         * json: unknown field "enable"
         */
        if (this.config.dns) {
            delete this.config.dns.enable;

            /*
             * Legacy DNS fakeip object was removed in
             * newer Sing-box versions.
             */
            if (this.singboxIs114OrNewer) {
                delete this.config.dns.fakeip;

                /*
                 * Deprecated independent DNS cache option.
                 */
                delete this.config.dns.independent_cache;
            }
        }

        /*
         * Modern rule-set HTTP client handling.
         */
        if (
            this.singboxIs114OrNewer &&
            this.config.route &&
            Array.isArray(
                this.config.route.rule_set
            )
        ) {
            for (
                const ruleSet
                of this.config.route.rule_set
            ) {
                if (
                    ruleSet?.type === 'remote'
                ) {
                    delete ruleSet.download_detour;

                    ruleSet.http_client =
                        RULE_SET_HTTP_CLIENT_TAG;
                }
            }
        }
    }

    /**
     * Build route target.
     */
    buildRouteTarget(rule) {
        if (
            REJECT_ACTION_RULES.has(
                rule?.outbound
            ) ||
            rule?.outbound === 'REJECT'
        ) {
            return {
                action: 'reject'
            };
        }

        return {
            outbound:
                this.t(
                    `outboundNames.${rule.outbound}`
                )
        };
    }

    /**
     * Configure remote rule-set downloads.
     *
     * Sing-box 1.14+:
     *   use explicit HTTP client
     *
     * Older versions:
     *   use download_detour
     */
    configureRuleSetDownload() {
        if (!this.config.route) {
            this.config.route = {};
        }

        if (
            !Array.isArray(
                this.config.route.rule_set
            )
        ) {
            this.config.route.rule_set = [];
        }

        /*
         * Sing-box 1.14+
         */
        if (this.singboxIs114OrNewer) {
            if (
                !Array.isArray(
                    this.config.http_clients
                )
            ) {
                this.config.http_clients = [];
            }

            const hasClient =
                this.config.http_clients.some(
                    client =>
                        client?.tag ===
                        RULE_SET_HTTP_CLIENT_TAG
                );

            if (!hasClient) {
                this.config.http_clients.push({
                    tag:
                        RULE_SET_HTTP_CLIENT_TAG,
                    detour: 'DIRECT'
                });
            }

            this.config.route.default_http_client =
                RULE_SET_HTTP_CLIENT_TAG;

            for (
                const ruleSet
                of this.config.route.rule_set
            ) {
                if (
                    ruleSet?.type === 'remote'
                ) {
                    delete ruleSet.download_detour;

                    ruleSet.http_client =
                        RULE_SET_HTTP_CLIENT_TAG;
                }
            }

            return;
        }

        /*
         * Sing-box 1.11 / 1.12 / 1.13
         */
        for (
            const ruleSet
            of this.config.route.rule_set
        ) {
            if (
                ruleSet?.type === 'remote' &&
                !ruleSet.download_detour
            ) {
                ruleSet.download_detour =
                    'DIRECT';
            }
        }
    }

    formatConfig() {
        const rules =
            generateRules(
                this.selectedRules,
                this.customRules
            );

        const {
            site_rule_sets,
            ip_rule_sets
        } = generateRuleSets(
            this.selectedRules,
            this.customRules
        );

        this.config.route.rule_set = [
            ...site_rule_sets,
            ...ip_rule_sets
        ];

        /*
         * Configure rule-set downloading before
         * generating the final route rules.
         */
        this.configureRuleSetDownload();

        /*
         * Add outbound_providers.
         */
        if (
            this.providerUrls.length > 0
        ) {
            const existingProviders =
                Array.isArray(
                    this.config.outbound_providers
                )
                    ? this.config.outbound_providers
                    : [];

            const newProviders =
                this.generateOutboundProviders();

            this.config.outbound_providers = [
                ...existingProviders,
                ...newProviders
            ];
        }

        /*
         * Validate generated groups.
         */
        this.validateOutbounds();

        /*
         * Remove legacy special outbounds.
         */
        this.sanitizeLegacySpecialOutbounds();

        /*
         * IMPORTANT:
         * Perform modern Sing-box schema cleanup
         * immediately before generating final output.
         */
        this.sanitizeModernSingboxConfig();

        const attachProtocolIfNeeded =
            (entry, rule) => {
                if (
                    Array.isArray(
                        rule?.protocol
                    ) &&
                    rule.protocol.length > 0
                ) {
                    entry.protocol =
                        rule.protocol;
                }

                return entry;
            };

        const hasMatchValues =
            value => {
                if (
                    Array.isArray(value)
                ) {
                    return value.length > 0;
                }

                if (
                    typeof value === 'string'
                ) {
                    return value.trim() !== '';
                }

                return false;
            };

        /*
         * Source IP CIDR rules.
         */
        rules
            .filter(
                rule =>
                    Array.isArray(
                        rule.src_ip_cidr
                    ) &&
                    rule.src_ip_cidr.length > 0
            )
            .map(rule => {
                this.config.route.rules.push(
                    attachProtocolIfNeeded(
                        {
                            source_ip_cidr:
                                rule.src_ip_cidr,
                            ...this.buildRouteTarget(
                                rule
                            )
                        },
                        rule
                    )
                );
            });

        /*
         * Domain rules.
         */
        rules
            .filter(
                rule =>
                    hasMatchValues(
                        rule.domain_suffix
                    ) ||
                    hasMatchValues(
                        rule.domain_keyword
                    )
            )
            .map(rule => {
                const entry = {
                    ...this.buildRouteTarget(
                        rule
                    )
                };

                if (
                    hasMatchValues(
                        rule.domain_suffix
                    )
                ) {
                    entry.domain_suffix =
                        rule.domain_suffix;
                }

                if (
                    hasMatchValues(
                        rule.domain_keyword
                    )
                ) {
                    entry.domain_keyword =
                        rule.domain_keyword;
                }

                this.config.route.rules.push(
                    attachProtocolIfNeeded(
                        entry,
                        rule
                    )
                );
            });

        /*
         * Site rule-set rules.
         */
        rules
            .filter(
                rule =>
                    !!rule.site_rules[0]
            )
            .map(rule => {
                this.config.route.rules.push(
                    attachProtocolIfNeeded(
                        {
                            rule_set: [
                                ...(rule.site_rules.length > 0 &&
                                rule.site_rules[0] !== ''
                                    ? rule.site_rules
                                    : [])
                            ],
                            ...this.buildRouteTarget(
                                rule
                            )
                        },
                        rule
                    )
                );
            });

        /*
         * IP rule-set rules.
         */
        rules
            .filter(
                rule =>
                    !!rule.ip_rules[0]
            )
            .map(rule => {
                this.config.route.rules.push(
                    attachProtocolIfNeeded(
                        {
                            rule_set: [
                                ...(rule.ip_rules
                                    .map(
                                        ip =>
                                            ip.trim()
                                    )
                                    .filter(
                                        ip =>
                                            ip !== ''
                                    )
                                    .map(
                                        ip =>
                                            `${ip}-ip`
                                    ))
                            ],
                            ...this.buildRouteTarget(
                                rule
                            )
                        },
                        rule
                    )
                );
            });

        /*
         * IP CIDR rules.
         */
        rules
            .filter(
                rule =>
                    hasMatchValues(
                        rule.ip_cidr
                    )
            )
            .map(rule => {
                this.config.route.rules.push(
                    attachProtocolIfNeeded(
                        {
                            ip_cidr:
                                rule.ip_cidr,
                            ...this.buildRouteTarget(
                                rule
                            )
                        },
                        rule
                    )
                );
            });

        /*
         * Route rule order:
         *
         * 1. sniff
         * 2. DNS hijack
         * 3. Clash direct mode
         * 4. Clash global mode
         */
        this.config.route.rules.unshift(
            {
                action: 'sniff'
            },
            {
                protocol: 'dns',
                action: 'hijack-dns'
            },
            {
                clash_mode: 'direct',
                outbound: 'DIRECT'
            },
            {
                clash_mode: 'global',
                outbound:
                    this.t(
                        'outboundNames.Node Select'
                    )
            }
        );

        this.config.route.auto_detect_interface =
            true;

        this.config.route.final =
            this.t(
                'outboundNames.Fall Back'
            );

        /*
         * Clash API / Clash UI.
         */
        if (
            this.enableClashUI ||
            this.externalController ||
            this.externalUiDownloadUrl
        ) {
            const defaultExternalController =
                '0.0.0.0:9090';

            const defaultExternalUiDownloadUrl =
                'https://gh-proxy.com/https://github.com/Zephyruso/zashboard/archive/refs/heads/gh-pages.zip';

            const defaultExternalUi =
                './ui';

            const defaultSecret = '';

            const defaultDownloadDetour =
                'DIRECT';

            const defaultClashMode =
                'rule';

            this.config.experimental =
                this.config.experimental || {};

            const existingClashApi =
                this.config.experimental.clash_api ||
                {};

            const externalController =
                this.externalController ||
                existingClashApi.external_controller ||
                defaultExternalController;

            const externalUiDownloadUrl =
                this.externalUiDownloadUrl ||
                existingClashApi.external_ui_download_url ||
                defaultExternalUiDownloadUrl;

            const externalUi =
                existingClashApi.external_ui ||
                defaultExternalUi;

            const secret =
                existingClashApi.secret ??
                defaultSecret;

            const externalUiDownloadDetour =
                existingClashApi.external_ui_download_detour ||
                defaultDownloadDetour;

            const clashMode =
                existingClashApi.default_mode ||
                defaultClashMode;

            this.config.experimental.clash_api = {
                ...existingClashApi,
                external_controller:
                    externalController,
                external_ui:
                    externalUi,
                external_ui_download_url:
                    externalUiDownloadUrl,
                external_ui_download_detour:
                    externalUiDownloadDetour,
                secret,
                default_mode:
                    clashMode
            };
        }

        /*
         * Run one final modern-schema cleanup.
         *
         * This is intentionally done at the very end,
         * because other builder methods may add DNS/rule-set
         * fields while building the configuration.
         */
        this.sanitizeModernSingboxConfig();

        return this.config;
    }
}
