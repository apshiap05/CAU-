'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chrome-extension', 'manifest.json'), 'utf8'));
const userscript = fs.readFileSync(path.join(root, 'userscript', 'cau-course-watcher.user.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'chrome-extension', 'content.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'chrome-extension', 'popup.html'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const userscriptVersion = userscript.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
assert.ok(userscriptVersion, '找不到油猴脚本 @version');
assert.equal(userscriptVersion, manifest.version, 'Chrome 与油猴脚本版本必须保持一致');
assert.match(content, new RegExp(`Chrome v${manifest.version.replace(/\./g, '\\.')}`));
assert.match(popup, new RegExp(`Chrome 扩展 v${manifest.version.replace(/\./g, '\\.')}`));
assert.match(changelog, new RegExp(`^## v${manifest.version.replace(/\./g, '\\.')}\\b`, 'm'));

process.stdout.write(`release version consistency: v${manifest.version} ok\n`);
