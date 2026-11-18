// Bundles that share the v3 intake contract. 3.1 changes wording and order only.
export const V3_BUNDLE_IDS = Object.freeze(['malssi-intake-3.0.0-rc1', 'malssi-intake-3.1.0-rc1']);
export const ACTIVE_V3_BUNDLE_ID = 'malssi-intake-3.1.0-rc1';
export const isV3BundleId = value => V3_BUNDLE_IDS.includes(value);
