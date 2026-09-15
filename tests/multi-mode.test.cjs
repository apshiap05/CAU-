'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sources = [
  path.join(__dirname, '..', 'userscript', 'cau-course-watcher.user.js'),
  path.join(__dirname, '..', 'chrome-extension', 'content.js'),
];

function loadTestApi(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const instrumented = source.replace(
    /\n\s*init\(\);\s*\n\}\)\(\);\s*$/,
    '\n  globalThis.__multiModeTest = { DEFAULT_CONFIG, sanitizeConfig, activeCourseConfigs, advanceCourseIndex, state };\n})();',
  );
  assert.notEqual(instrumented, source, `无法挂载测试接口：${sourcePath}`);
  const context = vm.createContext({
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(instrumented, context, { filename: sourcePath });
  return context.__multiModeTest;
}

for (const sourcePath of sources) {
  const api = loadTestApi(sourcePath);
  const legacy = api.sanitizeConfig({
    courseName: ' 羽毛球 ',
    teacher: '田野',
    minRemaining: 2,
    selectionStrategy: 'first',
    intervalMs: 5000,
  });
  assert.equal(legacy.mode, 'normal');
  assert.equal(legacy.courses.length, 1);
  assert.equal(legacy.courses[0].courseName, '羽毛球');
  assert.equal(legacy.courses[0].teacher, '田野');
  assert.equal(legacy.courses[0].minRemaining, 2);
  assert.equal(legacy.courses[0].selectionStrategy, 'first');

  const courses = Array.from({ length: 5 }, (_, index) => ({
    courseName: `课程${index + 1}`,
    minRemaining: index + 1,
    selectionStrategy: index % 2 ? 'first' : 'maxRemaining',
  }));
  const multi = api.sanitizeConfig({ ...api.DEFAULT_CONFIG, mode: 'multi', courses });
  assert.equal(multi.courses.length, 4, '课程数量必须限制为 4');
  assert.deepEqual(
    Array.from(api.activeCourseConfigs(multi), (course) => course.courseName),
    ['课程1', '课程2', '课程3', '课程4'],
  );

  api.state.config = multi;
  api.state.courseIndex = 0;
  const sequence = [];
  for (let index = 0; index < 5; index += 1) {
    sequence.push(api.state.courseIndex);
    api.advanceCourseIndex();
  }
  assert.deepEqual(sequence, [0, 1, 2, 3, 0], '轮询顺序必须循环前进');

  const normal = api.sanitizeConfig({ ...multi, mode: 'normal' });
  assert.equal(api.activeCourseConfigs(normal).length, 1, '正常模式只能启用第一门课程');
  assert.match(fs.readFileSync(sourcePath, 'utf8'), /data-remove-course/);
}

process.stdout.write('multi-mode configuration and rotation tests: ok\n');
