/** Shared read failures also occur during registration/import preflight. */
export const sourceReadStatuses = {
  SOURCE_UNAVAILABLE: 503, SOURCE_NODE_UNAVAILABLE: 503,
  SOURCE_BUSY: 503, SOURCE_READ_TIMEOUT: 503,
};
