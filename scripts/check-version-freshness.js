#!/usr/bin/env node
'use strict';

/**
 * Fail when shipped code changed but the version did not.
 *
 * Claude Code keys its plugin cache on the version string. `plugin marketplace
 * update` fetches, compares versions, sees no change and stops — so a repo can
 * be fully pushed, with every commit on the remote, and still serve stale code
 * forever. There is no error and no warning; the update just reports success.
 *
 * This repo lost three commits to exactly that, and the ROADMAP had already
 * warned about it in writing. A memo cannot fire. This can.
 *
 * Run with --fix to print the bump you need rather than guessing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, '.claude-plugin', 'plugin.json');

// Changing these cannot change what the plugin does at runtime, so they never
// require a bump on their own.
const NOT_SHIPPED = [
  /^tests\//, /^benchmark\//, /^docs\//, /^scripts\//, /^\.handoff\//,
  /^CHANGELOG\.md$/, /^\.gitignore$/, /^node_modules\//, /^HANDOFF\.md$/,
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function currentVersion() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;
}

/** The commit that last set the version to what it is now. */
function lastBumpCommit(version) {
  const out = git(['log', '--format=%H', '-S', `"version": "${version}"`, '--', '.claude-plugin/plugin.json']);
  const commits = out.split('\n').filter(Boolean);
  return commits.length ? commits[commits.length - 1] : null;
}

function main() {
  const version = currentVersion();
  const bump = lastBumpCommit(version);

  if (!bump) {
    console.log(`version ${version} has no bump commit yet (uncommitted); nothing to check.`);
    return 0;
  }

  const changed = git(['diff', '--name-only', `${bump}..HEAD`])
    .split('\n')
    .filter(Boolean)
    .filter((f) => !NOT_SHIPPED.some((re) => re.test(f)));

  if (changed.length === 0) {
    console.log(`version ${version} is current: no shipped file has changed since it was set.`);
    return 0;
  }

  const [major, minor, patch] = version.split('.').map(Number);
  console.error(
    `version ${version} is stale. ${changed.length} shipped file(s) changed since it was set:\n`
    + changed.map((f) => `  ${f}`).join('\n')
    + `\n\nClaude Code keys its plugin cache on the version. Until this is bumped in BOTH\n`
    + `.claude-plugin/plugin.json and .claude-plugin/marketplace.json, "plugin marketplace\n`
    + `update" will report success and keep serving the old code.\n\n`
    + `Suggested: ${major}.${minor}.${patch + 1} for a fix, ${major}.${minor + 1}.0 for a feature, `
    + `${major + 1}.0.0 if anything breaks.`
  );
  return 1;
}

process.exit(main());
