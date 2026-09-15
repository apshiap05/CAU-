'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sources = [
  ['Chrome 扩展', path.join(root, 'chrome-extension', 'content.js')],
  ['Tampermonkey 脚本', path.join(root, 'userscript', 'cau-course-watcher.user.js')],
];

for (const [name, file] of sources) {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /id="cau-cw-add-course" class="cau-cw-add-btn"/, `${name} 应使用独立的添加课程按钮样式`);
  assert.match(source, /<span class="cau-cw-add-symbol" aria-hidden="true">＋<\/span><span>添加课程<\/span>/, `${name} 应显示明确的添加课程标签`);
  assert.match(source, /\.cau-cw-add-btn[\s\S]*?border-radius: 999px;/, `${name} 的添加课程按钮应为胶囊形状`);
  assert.match(source, /\.cau-cw-add-btn:hover:not\(:disabled\)/, `${name} 应提供悬停反馈`);
  assert.match(source, /\.cau-cw-add-btn:focus-visible/, `${name} 应提供键盘焦点反馈`);
  assert.match(source, /最多可配置.*MAX_COURSES.*门课程/, `${name} 应在达到上限时说明原因`);
  assert.doesNotMatch(source, /id="cau-cw-add-course" class="cau-cw-small-btn"/, `${name} 不应继续复用方形删除按钮样式`);
}

process.stdout.write('panel add-course control layout: ok\n');
