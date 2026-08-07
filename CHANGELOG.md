# Changelog

All notable changes to the `pipeline-steps` project are documented here.
## 2026-07-30 .. 2026-08-05

### Added
- Add changelog links to all README.md files across packages and apps
- Generate CHANGELOG.md files for all packages and apps
- Add AGENTS.md documentation for agents across all packages and apps.

### Changed
- Rename @wgogol/changelog-live to @warpgogol/changelog-live in all relevant packages and documentation
- Migrate forge dependency from @webgogol/forge to @warpgogol/forge.
- Summarize HDRI audits by quarter.

### Fixed
- Add percentage display to LLM cost estimation warning text per RFC-0065 and update related tests
- Downgrade TypeScript from 7.0.2 to 6.0.3 for compatibility with typescript-eslint.

### Removed
- Remove outdated entries from CHANGELOG.md files during regeneration.

### Documentation
- Update AGENTS.md files, documentation for RFC-0065, and rule sets in changelog.md.

## 2026-07-23 .. 2026-07-29

### Added
- Add missing package.json files to all applications and packages.
- Add README.md for project overview and usage.

### Changed
- Upgrade dependencies across the workspace for enhanced compatibility.
- Optimize Tier Light LLM models for cost efficiency via OpenRouter.
- Refactor pipeline-steps to extract a shared SignatureStep base class.

### Fixed
- Align vitest versions to resolve testing inconsistencies.
- Restore missing package.json files after recent removals.
- Eliminate all pnpm install warnings for a cleaner installation process.
- Flatten project structure by moving apps/source/* to the repository root and cleaning up legacy files.

### Removed
- Remove code-compass from all package.json files and scripts to reduce unused dependencies.

### Documentation
- Merge AGENTS.md content for improved documentation clarity.

## 2026-07-09 .. 2026-07-15

### Added
- Add @eslint/js and typescript-eslint to devDependencies in all packages and apps to ensure consistent linting.
- Add eslint to devDependencies across all packages and apps to standardize linting.

### Changed
- Normalize package.json formatting across all apps and packages.
- Rename @wgogol/code-compass to @syrokomskyi/code-compass for package consistency.
- Rename @org NPM scope to @syrokomskyi throughout the monorepo.
- Refactor: rename hdri-factory to factory, digital-observatory to observatory, and hdri-dashboard to dashboard for clearer project structure.
- Bump dependencies for Astro, tsx, typescript-eslint, systeminformation, @astrojs/cloudflare, @cloudflare/workers-types, and @aws-sdk/client-s3 across the monorepo.
- Upgrade dependencies in all apps and packages to latest versions.

### Fixed
- Invoke eslint binary directly using node in all packages and apps for improved cross-platform compatibility.

### Removed
- Remove redundant index and export statements for observatory-emit due to consolidation in pipeline-steps.

### Documentation
- Add and update documentation for new base classes, shared helpers, and pipeline-steps.
- Update AGENTS.md and README files with latest design, pipeline steps, and rate-limit improvements.

## 2026-07-02 .. 2026-07-08

### Added
- Add COMPASS library to all core packages and enable root-level commands and scaffolding with the annotate command.
- Introduce new utility and configuration files across HDRI, Observatory, Pipeline, Rate-Limit, Strings, and Utils packages to support COMPASS operations.
- Extract shared rate limit runtime to a new rate-limit package.

### Changed
- Rename @org/compass-checks to @wgogol/compass and refactor related package and import references.
- Rename @wgogol/compass to @wgogol/code-compass and update all dependent packages and scripts.
- Replace use of 'any' types with 'unknown' and appropriate interfaces in IllustrateGoogleGogol and cross-db-read-only-step for improved type safety.

### Fixed
- Fix up package manifests and dependency references after COMPASS renames and code migrations.

### Removed
- Remove deprecated compass-checks, compass-core, and compass-codegen packages and outdated test files.

### Documentation
- Update documentation to reflect COMPASS library changes, renames, and new scaffolding command.

## 2026-06-18 .. 2026-06-24

### Added
- Add minor enhancements to Germany states geo data for the HDRI dashboard.
- Add new prompt files for Git history analysis and localize-concept-image features.

### Changed
- Reformat codebase to ensure consistent style and alignment across all applications, packages, and documentation.

### Fixed
- Fix minor typographical and formatting issues throughout the project, including markdown prompts and test specifications.

### Removed
- Remove source-records and select obsolete legal doc generator files for improved maintainability.

### Security
- Update dependencies to resolve potential vulnerabilities as part of regular maintenance.

### Documentation
- Update and reformat documentation files for improved clarity and structure throughout the project.

## 2026-05-28 .. 2026-06-03

### Added
- Document HDRI Analysis Platform architecture and English translation in root README.md.

### Changed
- Update README files to reflect factory, observatory, and dashboard structure; remove obsolete migration guide links; and improve cross-references.

### Fixed
- Correct documentation references and remove outdated legacy pipeline sections.

### Removed
- Remove references to legacy pipeline and obsolete migration guides from documentation.

### Documentation
- Translate documentation from German to English and update platform structure descriptions.

## 2026-04-23 .. 2026-04-29

### Added
- Add new checks, modules, and handlers to pipeline and kernel packages to enable advanced business logic and site analysis functionality.
- Add Grace-related codegen scripts and prompts to support programmatic anchor and backfill operations.
- Add new CLI utilities, types, and runtime extensions across site-kernel packages for improved developer flexibility.
- Add README documentation to all packages and application modules.

### Changed
- Update and enhance core pipeline and kernel logic to support latest build requirements and improved runtime compatibility.

### Fixed
- Resolve build errors, allowing 'pnpm build' to complete successfully.

### Removed
- Archive the business-base app and remove all related source code, configuration, test files, and documentation from the repository.

## 2026-04-16 .. 2026-04-22

### Added
- Add scripts and configuration for pipeline orchestration, monitoring, and scalability.
- Add new utility functions and improvements across pipeline-steps, including enhanced k-anonymity and logging capabilities.

### Changed
- Refactor pipeline step logic for improved reliability and maintainability.
- Update pipeline and script files for better compatibility and performance.

### Fixed
- Correct logic in pipeline scripts and pipeline steps to resolve identified errors.

### Removed
- Remove redundant TypeScript compiler options from all project configurations in favor of centralized tsconfig.base.json.

### Documentation
- Expand and improve documentation for AGENTS, pipeline steps, and scripts to assist both AI and human developers.

## 2026-04-09 .. 2026-04-15

### Added
- Add initial project structure, including monorepo setup, configuration, and core packages for async, colors, pipeline, steps, strings, and utils.
- Add apps including inticle-webgogol-3 and site-webgogol-3 with foundational source code, run logic, and application scaffolding.
- Add detailed pipeline implementation with support for artifact validation, AI processing, input/output phases, editorial steps, translation, and content generation features.
- Add comprehensive pipeline documentation and guides, including prompts, step-by-step procedures, and best practices.
- Add sample input, intermediate outputs, assets, and demonstration projects in the pipeline, web, and specification directories.
- Add accessibility, SEO, brand alignment, legal docs, client handoff, wireframing, and publication packaging modules for site workflows.

### Changed
- Clone codebase and foundational logic from the previous pipelines-webgogol-3 project to establish the current architecture.

### Fixed
- Resolve initial setup inconsistencies to enable successful bootstrapping and builds across monorepo packages and applications.

### Removed
- Remove reliance on the original pipelines-webgogol-3 project structure, establishing a new standalone repository.

### Documentation
- Document pipeline processes, app usage, prompts, and specifications to guide users in adopting and understanding the new system.
