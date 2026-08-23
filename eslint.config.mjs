/**
 * <MODULE_CONTRACT><purpose>Provide eslint config behavior for the packages pipeline pipeline-steps subsystem and its direct callers.</purpose><non-goals><item>Do not define unrelated cross-workspace policy or orchestration behavior.</item></non-goals></MODULE_CONTRACT>
 * <CHANGE_SUMMARY>
  <item>Document the existing eslint.config module contract for Compass-aware maintenance.</item>
</CHANGE_SUMMARY>
 */

import baseConfig from "../../../eslint.config.mjs";

export default [
  ...baseConfig,
  {
    files: ["**/*.ts", "**/*.js"],
    rules: {},
  },
];
