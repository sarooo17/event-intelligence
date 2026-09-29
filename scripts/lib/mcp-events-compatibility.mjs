export const MCP_EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

export const MCP_EVENTS_COMPATIBILITY_PROFILES = Object.freeze({
  'experimental-extension-2026-09-25': Object.freeze({
    id: 'experimental-extension-2026-09-25',
    capabilityStyle: 'extension',
    extensionId: MCP_EVENTS_EXTENSION_ID,
    listMethod: 'events/list',
    pollMethod: 'events/poll',
    deliveryModes: Object.freeze(['poll', 'push', 'webhook']),
    experimental: true,
  }),
});

export const DEFAULT_MCP_EVENTS_COMPATIBILITY_PROFILE =
  'experimental-extension-2026-09-25';

export function getMcpEventsCompatibilityProfile(profileId) {
  const id =
    !profileId || profileId === 'auto'
      ? DEFAULT_MCP_EVENTS_COMPATIBILITY_PROFILE
      : String(profileId);
  const profile = MCP_EVENTS_COMPATIBILITY_PROFILES[id];
  if (!profile) {
    const error = new Error(`Unknown MCP Events compatibility profile: ${id}`);
    error.code = 'MCP_EVENTS_PROFILE_UNKNOWN';
    throw error;
  }
  return profile;
}

export function profileAdvertisedByCapabilities(profile, capabilities = {}) {
  if (profile.capabilityStyle !== 'extension') return false;
  const extensions =
    capabilities?.extensions &&
    !Array.isArray(capabilities.extensions) &&
    typeof capabilities.extensions === 'object'
      ? capabilities.extensions
      : {};
  return Object.prototype.hasOwnProperty.call(
    extensions,
    profile.extensionId,
  );
}

export function resolveMcpEventsCompatibilityProfile({
  capabilities,
  requested = 'auto',
} = {}) {
  const profile = getMcpEventsCompatibilityProfile(requested);
  return profileAdvertisedByCapabilities(profile, capabilities)
    ? profile
    : null;
}
