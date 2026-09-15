// ==UserScript==
// @name         中国农业大学教务选课余量监控助手
// @namespace    local.cau.course-watcher
// @version      1.3.0
// @description  支持单课程或最多四门课程轮询，发现余量后使用页面原生流程选课。
// @author       apshiap05
// @license      Apache-2.0
// @homepageURL  https://github.com/apshiap05/CAU-
// @supportURL   https://github.com/apshiap05/CAU-/issues
// @downloadURL  https://raw.githubusercontent.com/apshiap05/CAU-/main/userscript/cau-course-watcher.user.js
// @updateURL    https://raw.githubusercontent.com/apshiap05/CAU-/main/userscript/cau-course-watcher.user.js
// @match        https://newjw.cau.edu.cn/jsxsd/xsxk/xsxk_index*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_ID = 'cau-course-watcher';
  const STORAGE_KEY = `${SCRIPT_ID}:config:v1`;
  const BRIDGE_ID = `${SCRIPT_ID}-page-bridge`;
  const BRIDGE_REQUEST_EVENT = `${SCRIPT_ID}:select-request`;
  const BRIDGE_RESPONSE_EVENT = `${SCRIPT_ID}:select-response`;
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const MAX_COURSES = 4;

  const DEFAULT_COURSE = Object.freeze({
    courseName: '',
    matchMode: 'exact',
    courseCode: '',
    teacher: '',
    classNumber: '',
    campus: '',
    timeKeyword: '',
    minRemaining: 1,
    selectionStrategy: 'maxRemaining',
  });

  const DEFAULT_CONFIG = Object.freeze({
    mode: 'normal',
    courses: Object.freeze([DEFAULT_COURSE]),
    intervalMs: 5000,
    jitterMs: 900,
    maxAttempts: 0,
    showFullCourses: true,
    autoConfirmAllPrompts: true,
    desktopNotification: true,
    sound: true,
  });

  const state = {
    running: false,
    inFlight: false,
    attempts: 0,
    timer: null,
    countdownTimer: null,
    nextRunAt: 0,
    consecutiveErrors: 0,
    transientFailures: 0,
    courseIndex: 0,
    stopRequested: false,
    config: loadConfig(),
    audioContext: null,
    lastRows: [],
  };

  let ui = null;

  function loadConfig() {
    try {
      let saved;
      if (typeof GM_getValue === 'function') {
        saved = GM_getValue(STORAGE_KEY, null);
      } else {
        saved = localStorage.getItem(STORAGE_KEY);
      }
      if (!saved) return sanitizeConfig(DEFAULT_CONFIG);
      const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
      const merged = { ...DEFAULT_CONFIG, ...parsed };
      merged.courses = Array.isArray(parsed.courses) ? parsed.courses : [parsed];
      if (
        !Object.prototype.hasOwnProperty.call(parsed, 'autoConfirmAllPrompts') &&
        Object.prototype.hasOwnProperty.call(parsed, 'autoConfirmFirstPrompt')
      ) {
        merged.autoConfirmAllPrompts = Boolean(parsed.autoConfirmFirstPrompt);
      }
      return sanitizeConfig(merged);
    } catch (error) {
      console.warn('[CAU Course Watcher] 无法读取配置，将使用默认值。', error);
      return sanitizeConfig(DEFAULT_CONFIG);
    }
  }

  function saveConfig(config) {
    const clean = sanitizeConfig(config);
    state.config = clean;
    const serialized = JSON.stringify(clean);
    if (typeof GM_setValue === 'function') {
      GM_setValue(STORAGE_KEY, serialized);
    } else {
      localStorage.setItem(STORAGE_KEY, serialized);
    }
    return clean;
  }

  function sanitizeConfig(input) {
    const number = (value, fallback, min, max) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    };
    const sanitizeCourse = (course = {}) => ({
      courseName: String(course.courseName || '').trim(),
      matchMode: course.matchMode === 'contains' ? 'contains' : 'exact',
      courseCode: String(course.courseCode || '').trim(),
      teacher: String(course.teacher || '').trim(),
      classNumber: String(course.classNumber || '').trim(),
      campus: String(course.campus || '').trim(),
      timeKeyword: String(course.timeKeyword || '').trim(),
      minRemaining: number(course.minRemaining, DEFAULT_COURSE.minRemaining, 1, 9999),
      selectionStrategy: course.selectionStrategy === 'first' ? 'first' : 'maxRemaining',
    });
    const rawCourses = Array.isArray(input.courses) ? input.courses : [input];
    const courses = rawCourses.slice(0, MAX_COURSES).map(sanitizeCourse);
    if (!courses.length) courses.push(sanitizeCourse(DEFAULT_COURSE));
    return {
      mode: input.mode === 'multi' ? 'multi' : 'normal',
      courses,
      intervalMs: number(input.intervalMs, DEFAULT_CONFIG.intervalMs, 3000, 120000),
      jitterMs: number(input.jitterMs, DEFAULT_CONFIG.jitterMs, 0, 10000),
      maxAttempts: number(input.maxAttempts, DEFAULT_CONFIG.maxAttempts, 0, 1000000),
      showFullCourses: Boolean(input.showFullCourses),
      autoConfirmAllPrompts: Boolean(input.autoConfirmAllPrompts),
      desktopNotification: Boolean(input.desktopNotification),
      sound: Boolean(input.sound),
    };
  }

  function activeCourseConfigs(config) {
    const courses = config.mode === 'multi' ? config.courses : config.courses.slice(0, 1);
    return courses.map((course, targetIndex) => ({ ...config, ...course, targetIndex }));
  }

  function targetLabel(config) {
    const total = activeCourseConfigs(state.config).length;
    return total > 1 ? `课程 ${config.targetIndex + 1}/${total}“${config.courseName}”` : `“${config.courseName}”`;
  }

  function normalize(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compact(value) {
    return normalize(value).replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntil(predicate, timeoutMs, stepMs = 120) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const result = predicate();
        if (result) return result;
      } catch (error) {
        lastError = error;
      }
      await sleep(stepMs);
    }
    if (lastError) throw lastError;
    throw new Error(`等待页面响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-style`;
    style.textContent = `
      #${SCRIPT_ID}-panel, #${SCRIPT_ID}-panel * { box-sizing: border-box; }
      #${SCRIPT_ID}-panel {
        position: fixed; top: 18px; right: 18px; z-index: 2147483646;
        width: 440px; max-height: calc(100vh - 36px); overflow: auto;
        color: #203129; background: #f8fbf9; border: 1px solid #9bc8aa;
        border-radius: 12px; box-shadow: 0 14px 40px rgba(13, 63, 34, .24);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${SCRIPT_ID}-panel.cau-cw-collapsed .cau-cw-body { display: none; }
      #${SCRIPT_ID}-panel .cau-cw-header {
        position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
        gap: 8px; padding: 11px 13px; color: white; background: #25824b;
        border-radius: 11px 11px 0 0;
      }
      #${SCRIPT_ID}-panel .cau-cw-title { flex: 1; font-size: 15px; font-weight: 700; }
      #${SCRIPT_ID}-panel .cau-cw-icon-btn {
        width: 28px; height: 26px; padding: 0; color: white; background: rgba(255,255,255,.14);
        border: 1px solid rgba(255,255,255,.32); border-radius: 6px; cursor: pointer;
      }
      #${SCRIPT_ID}-panel .cau-cw-body { padding: 12px; }
      #${SCRIPT_ID}-panel .cau-cw-tabs {
        display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 10px;
        padding: 4px; background: #e4eee7; border-radius: 9px;
      }
      #${SCRIPT_ID}-panel .cau-cw-mode-tab {
        min-height: 34px; border: 0; border-radius: 7px; color: #45604d;
        background: transparent; font-weight: 700; cursor: pointer;
      }
      #${SCRIPT_ID}-panel .cau-cw-mode-tab.active { color: white; background: #25824b; }
      #${SCRIPT_ID}-panel .cau-cw-mode-tab:disabled { opacity: .58; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-status {
        display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px;
        padding: 9px; background: #edf6f0; border-radius: 8px;
      }
      #${SCRIPT_ID}-panel .cau-cw-status b { color: #126936; }
      #${SCRIPT_ID}-panel .cau-cw-section {
        margin: 9px 0; padding: 10px; background: white; border: 1px solid #d9e8de; border-radius: 8px;
      }
      #${SCRIPT_ID}-panel .cau-cw-section-title { margin-bottom: 7px; font-weight: 700; color: #176f3b; }
      #${SCRIPT_ID}-panel .cau-cw-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      #${SCRIPT_ID}-panel .cau-cw-course-block {
        margin-top: 8px; padding: 9px; background: #f7faf8; border: 1px solid #d4e4d9; border-radius: 8px;
      }
      #${SCRIPT_ID}-panel .cau-cw-course-block:first-child { margin-top: 0; }
      #${SCRIPT_ID}-panel .cau-cw-course-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
      #${SCRIPT_ID}-panel .cau-cw-course-head b { color: #315e40; }
      #${SCRIPT_ID}-panel .cau-cw-small-btn {
        min-width: 30px; height: 28px; padding: 0 8px; border: 1px solid #9bc8aa;
        border-radius: 6px; color: #176f3b; background: #edf6f0; font-size: 18px; line-height: 1; cursor: pointer;
      }
      #${SCRIPT_ID}-panel .cau-cw-small-btn.cau-cw-remove { color: #a3322a; border-color: #e1b6b1; background: #fff1ef; }
      #${SCRIPT_ID}-panel .cau-cw-small-btn:disabled { opacity: .45; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      #${SCRIPT_ID}-panel label { display: block; color: #41574a; }
      #${SCRIPT_ID}-panel label > span { display: block; margin-bottom: 3px; }
      #${SCRIPT_ID}-panel input[type="text"],
      #${SCRIPT_ID}-panel input[type="number"],
      #${SCRIPT_ID}-panel select {
        width: 100%; height: 32px; padding: 4px 7px; color: #203129; background: white;
        border: 1px solid #b9cfc0; border-radius: 6px; outline: none;
      }
      #${SCRIPT_ID}-panel input:focus, #${SCRIPT_ID}-panel select:focus {
        border-color: #2d8c52; box-shadow: 0 0 0 2px rgba(45,140,82,.13);
      }
      #${SCRIPT_ID}-panel .cau-cw-check { display: flex; align-items: flex-start; gap: 7px; margin: 7px 0; }
      #${SCRIPT_ID}-panel .cau-cw-check input { margin-top: 3px; }
      #${SCRIPT_ID}-panel .cau-cw-arm {
        padding: 8px; background: #fff8e4; border: 1px solid #ecd78f; border-radius: 7px;
      }
      #${SCRIPT_ID}-panel .cau-cw-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 7px; }
      #${SCRIPT_ID}-panel .cau-cw-btn {
        min-height: 34px; padding: 6px 9px; border: 0; border-radius: 7px; cursor: pointer;
        color: white; background: #287e4a; font-weight: 650;
      }
      #${SCRIPT_ID}-panel .cau-cw-btn:hover { filter: brightness(1.07); }
      #${SCRIPT_ID}-panel .cau-cw-btn:disabled { opacity: .48; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-btn-secondary { color: #245538; background: #e4f1e8; }
      #${SCRIPT_ID}-panel .cau-cw-btn-danger { background: #b64b42; }
      #${SCRIPT_ID}-panel .cau-cw-hint { margin: 7px 0 0; color: #687970; font-size: 12px; }
      #${SCRIPT_ID}-panel .cau-cw-log {
        height: 132px; margin: 0; padding: 7px 7px 7px 24px; overflow: auto;
        color: #30483a; background: #f4f8f5; border: 1px solid #d6e5da; border-radius: 7px;
      }
      #${SCRIPT_ID}-panel .cau-cw-log li { margin: 2px 0; word-break: break-word; }
      #${SCRIPT_ID}-panel .cau-cw-log .error { color: #ad2e24; }
      #${SCRIPT_ID}-panel .cau-cw-log .success { color: #087333; font-weight: 700; }
      #${SCRIPT_ID}-panel .cau-cw-running { color: #fff3ad; }
      #${SCRIPT_ID}-panel .cau-cw-paused { color: #e3f3e8; }
      #${SCRIPT_ID}-toast {
        position: fixed; left: 50%; top: 22px; z-index: 2147483647; transform: translateX(-50%);
        max-width: min(720px, 86vw); padding: 11px 16px; color: white; background: #246d43;
        border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.22); font: 14px/1.45 "Microsoft YaHei", sans-serif;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createPanel() {
    if (document.getElementById(`${SCRIPT_ID}-panel`)) return;
    injectStyle();
    const panel = document.createElement('aside');
    panel.id = `${SCRIPT_ID}-panel`;
    panel.innerHTML = `
      <div class="cau-cw-header">
        <div class="cau-cw-title">选课余量监控助手 <small style="font-weight:500;opacity:.78">v1.3.0</small></div>
        <span id="cau-cw-run-state" class="cau-cw-paused">已停止</span>
        <button id="cau-cw-collapse" class="cau-cw-icon-btn" title="收起/展开">—</button>
      </div>
      <div class="cau-cw-body">
        <div class="cau-cw-tabs" role="tablist" aria-label="监控模式">
          <button class="cau-cw-mode-tab" type="button" role="tab" data-mode="normal">正常模式</button>
          <button class="cau-cw-mode-tab" type="button" role="tab" data-mode="multi">多选模式</button>
        </div>
        <div class="cau-cw-status">
          <div>页面：<b id="cau-cw-page-state">检测中</b></div>
          <div>查询：<b id="cau-cw-attempts">0 次</b></div>
          <div>结果：<b id="cau-cw-result">尚未查询</b></div>
          <div>下次：<b id="cau-cw-next">—</b></div>
        </div>

        <div class="cau-cw-section">
          <div class="cau-cw-section-heading">
            <div class="cau-cw-section-title">待选课程</div>
            <button id="cau-cw-add-course" class="cau-cw-small-btn" type="button" title="增加待选课程">＋</button>
          </div>
          <div id="cau-cw-course-list"></div>
          <p id="cau-cw-target-hint" class="cau-cw-hint"></p>
        </div>

        <div class="cau-cw-section">
          <div class="cau-cw-section-title">刷新与选择</div>
          <div class="cau-cw-grid">
            <label><span>刷新间隔（秒）</span><input id="cau-cw-interval" type="number" min="3" max="120" step="0.5"></label>
            <label><span>随机抖动（毫秒）</span><input id="cau-cw-jitter" type="number" min="0" max="10000" step="100"></label>
            <label style="grid-column: 1 / -1"><span>最多查询次数（全部课程合计）</span><input id="cau-cw-max-attempts" type="number" min="0" max="1000000" step="1" title="0 表示不限"></label>
          </div>
          <p class="cau-cw-hint">多选模式的全部课程共用这里的刷新间隔；相邻两次查询之间都会等待该间隔并附加随机抖动。</p>
          <label class="cau-cw-check"><input id="cau-cw-show-full" type="checkbox"><span>查询时显示已满课程，便于观察余量变化</span></label>
          <label class="cau-cw-check"><input id="cau-cw-auto-confirm" type="checkbox"><span>自动点击本次选课流程中的所有“确定”弹窗（包括班级确认和课程组确认）</span></label>
          <label class="cau-cw-check"><input id="cau-cw-notify" type="checkbox"><span>成功、验证码或异常时发送桌面通知</span></label>
          <label class="cau-cw-check"><input id="cau-cw-sound" type="checkbox"><span>重要事件播放提示音</span></label>
          <label class="cau-cw-check cau-cw-arm"><input id="cau-cw-arm" type="checkbox"><span><b>本次授权：</b>我确认上述条件无误，并授权发现余量后自动提交一次选课、按上述设置处理该次选课弹窗。此项不会保存，刷新页面后需重新勾选。</span></label>
        </div>

        <div class="cau-cw-actions">
          <button id="cau-cw-save" class="cau-cw-btn cau-cw-btn-secondary">保存配置</button>
          <button id="cau-cw-query" class="cau-cw-btn cau-cw-btn-secondary">仅查询一次</button>
          <button id="cau-cw-start" class="cau-cw-btn">开始监控</button>
          <button id="cau-cw-pause" class="cau-cw-btn cau-cw-btn-danger" disabled>立即停止</button>
          <button id="cau-cw-enter" class="cau-cw-btn cau-cw-btn-secondary">进入自由选课</button>
          <button id="cau-cw-clear-log" class="cau-cw-btn cau-cw-btn-secondary">清空日志</button>
        </div>
        <p class="cau-cw-hint">紧急停止：按 Esc。验证码、会话失效、不确定的选课结果或非余量类失败都会自动暂停。</p>

        <div class="cau-cw-section">
          <div class="cau-cw-section-title">运行日志</div>
          <ol id="cau-cw-log" class="cau-cw-log"></ol>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    ui = {
      panel,
      runState: panel.querySelector('#cau-cw-run-state'),
      pageState: panel.querySelector('#cau-cw-page-state'),
      attempts: panel.querySelector('#cau-cw-attempts'),
      result: panel.querySelector('#cau-cw-result'),
      next: panel.querySelector('#cau-cw-next'),
      log: panel.querySelector('#cau-cw-log'),
      start: panel.querySelector('#cau-cw-start'),
      pause: panel.querySelector('#cau-cw-pause'),
      arm: panel.querySelector('#cau-cw-arm'),
      courseList: panel.querySelector('#cau-cw-course-list'),
      addCourse: panel.querySelector('#cau-cw-add-course'),
      modeTabs: [...panel.querySelectorAll('.cau-cw-mode-tab')],
      targetHint: panel.querySelector('#cau-cw-target-hint'),
    };

    writeConfigToPanel(state.config);
    bindPanelEvents();
    updatePageStatus();
    log('助手已就绪。请先填写目标并使用“仅查询一次”核对结果。');
  }

  function field(id) {
    return document.getElementById(id);
  }

  function courseBlockTemplate(index) {
    return `
      <div class="cau-cw-course-block" data-course-index="${index}">
        <div class="cau-cw-course-head">
          <b>待选课程 ${index + 1}</b>
          <button class="cau-cw-small-btn cau-cw-remove" type="button" data-remove-course="${index}" title="删除这门课程">−</button>
        </div>
        <div class="cau-cw-grid">
          <label style="grid-column: 1 / -1"><span>课程名称（必填）</span><input data-course-field="courseName" type="text" placeholder="例如：羽毛球"></label>
          <label><span>名称匹配</span><select data-course-field="matchMode"><option value="exact">智能精确（推荐）</option><option value="contains">包含关键词</option></select></label>
          <label><span>课程编号（可选）</span><input data-course-field="courseCode" type="text" placeholder="例如：70013084"></label>
          <label><span>教师（可选）</span><input data-course-field="teacher" type="text" placeholder="包含匹配"></label>
          <label><span>课序号（可选）</span><input data-course-field="classNumber" type="text" placeholder="例如：507"></label>
          <label><span>校区（可选）</span><input data-course-field="campus" type="text" placeholder="例如：烟台研究院"></label>
          <label><span>时间关键词（可选）</span><input data-course-field="timeKeyword" type="text" placeholder="例如：星期六 1-2节"></label>
          <label><span>最低余量</span><input data-course-field="minRemaining" type="number" min="1" max="9999" step="1"></label>
          <label><span>多班选择策略</span><select data-course-field="selectionStrategy"><option value="maxRemaining">剩余容量最多</option><option value="first">页面中的第一班</option></select></label>
        </div>
      </div>
    `;
  }

  function renderCourseBlocks(courses) {
    const cleanCourses = sanitizeConfig({ ...state.config, courses }).courses;
    ui.courseList.innerHTML = cleanCourses.map((_, index) => courseBlockTemplate(index)).join('');
    [...ui.courseList.querySelectorAll('.cau-cw-course-block')].forEach((block, index) => {
      const course = cleanCourses[index];
      Object.entries(course).forEach(([key, value]) => {
        const input = block.querySelector(`[data-course-field="${key}"]`);
        if (input) input.value = String(value);
      });
    });
    updateCourseControls();
  }

  function readCourseBlocks() {
    return [...ui.courseList.querySelectorAll('.cau-cw-course-block')].map((block) => ({
      courseName: block.querySelector('[data-course-field="courseName"]').value,
      matchMode: block.querySelector('[data-course-field="matchMode"]').value,
      courseCode: block.querySelector('[data-course-field="courseCode"]').value,
      teacher: block.querySelector('[data-course-field="teacher"]').value,
      classNumber: block.querySelector('[data-course-field="classNumber"]').value,
      campus: block.querySelector('[data-course-field="campus"]').value,
      timeKeyword: block.querySelector('[data-course-field="timeKeyword"]').value,
      minRemaining: block.querySelector('[data-course-field="minRemaining"]').value,
      selectionStrategy: block.querySelector('[data-course-field="selectionStrategy"]').value,
    }));
  }

  function updateCourseControls() {
    if (!ui) return;
    const mode = ui.panel.dataset.mode === 'multi' ? 'multi' : 'normal';
    const blocks = [...ui.courseList.querySelectorAll('.cau-cw-course-block')];
    ui.modeTabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.disabled = state.running || state.inFlight;
    });
    ui.addCourse.hidden = mode !== 'multi';
    ui.addCourse.disabled = state.running || state.inFlight || blocks.length >= MAX_COURSES;
    blocks.forEach((block, index) => {
      block.hidden = mode === 'normal' && index > 0;
      const remove = block.querySelector('[data-remove-course]');
      remove.hidden = mode !== 'multi';
      remove.disabled = state.running || state.inFlight || blocks.length <= 1;
    });
    ui.targetHint.textContent = mode === 'multi'
      ? '可配置 1–4 门课程并按顺序交替查询；每门课程都可独立设置最低余量和多班策略。'
      : '同名课程有多个班时，建议至少填写教师、课序号或时间；否则默认选择余量最多的班。';
    field('cau-cw-query').textContent = mode === 'multi' ? '仅轮询一轮' : '仅查询一次';
  }

  function writeConfigToPanel(config) {
    ui.panel.dataset.mode = config.mode;
    renderCourseBlocks(config.courses);
    field('cau-cw-interval').value = String(config.intervalMs / 1000);
    field('cau-cw-jitter').value = String(config.jitterMs);
    field('cau-cw-max-attempts').value = String(config.maxAttempts);
    field('cau-cw-show-full').checked = config.showFullCourses;
    field('cau-cw-auto-confirm').checked = config.autoConfirmAllPrompts;
    field('cau-cw-notify').checked = config.desktopNotification;
    field('cau-cw-sound').checked = config.sound;
  }

  function readConfigFromPanel() {
    return sanitizeConfig({
      mode: ui.panel.dataset.mode,
      courses: readCourseBlocks(),
      intervalMs: Number(field('cau-cw-interval').value) * 1000,
      jitterMs: field('cau-cw-jitter').value,
      maxAttempts: field('cau-cw-max-attempts').value,
      showFullCourses: field('cau-cw-show-full').checked,
      autoConfirmAllPrompts: field('cau-cw-auto-confirm').checked,
      desktopNotification: field('cau-cw-notify').checked,
      sound: field('cau-cw-sound').checked,
    });
  }

  function bindPanelEvents() {
    field('cau-cw-collapse').addEventListener('click', () => {
      ui.panel.classList.toggle('cau-cw-collapsed');
      field('cau-cw-collapse').textContent = ui.panel.classList.contains('cau-cw-collapsed') ? '+' : '—';
    });

    ui.modeTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        if (state.running || state.inFlight) return;
        const config = readConfigFromPanel();
        config.mode = tab.dataset.mode === 'multi' ? 'multi' : 'normal';
        state.config = sanitizeConfig(config);
        writeConfigToPanel(state.config);
        log(`已切换到${state.config.mode === 'multi' ? '多选模式' : '正常模式'}。`);
      });
    });

    ui.addCourse.addEventListener('click', () => {
      if (state.running || state.inFlight) return;
      const courses = readCourseBlocks();
      if (courses.length >= MAX_COURSES) {
        toast(`最多只能监控 ${MAX_COURSES} 门课程`, true);
        return;
      }
      courses.push({ ...DEFAULT_COURSE });
      renderCourseBlocks(courses);
      log(`已增加待选课程块，当前共 ${courses.length} 门。`);
    });

    ui.courseList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-course]');
      if (!button || state.running || state.inFlight) return;
      const courses = readCourseBlocks();
      if (courses.length <= 1) return;
      const index = Number(button.dataset.removeCourse);
      if (!Number.isInteger(index) || index < 0 || index >= courses.length) return;
      const [removed] = courses.splice(index, 1);
      renderCourseBlocks(courses);
      log(`已删除${removed.courseName ? `“${removed.courseName}”` : `待选课程 ${index + 1}`}，当前共 ${courses.length} 门。`);
    });

    field('cau-cw-save').addEventListener('click', () => {
      saveConfig(readConfigFromPanel());
      writeConfigToPanel(state.config);
      log('配置已保存（不包含账号和密码）。', 'success');
      toast('配置已保存');
    });

    field('cau-cw-start').addEventListener('click', startMonitoring);
    field('cau-cw-pause').addEventListener('click', () => pauseMonitoring('用户手动停止。'));
    field('cau-cw-enter').addEventListener('click', async () => {
      try {
        await enterFreeCoursePage();
        log('已进入自由选课页面。', 'success');
      } catch (error) {
        handleFatal(error, '无法进入自由选课页面');
      }
    });
    field('cau-cw-query').addEventListener('click', queryOnceManually);
    field('cau-cw-clear-log').addEventListener('click', () => {
      ui.log.replaceChildren();
      log('日志已清空。');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && (state.running || state.inFlight)) pauseMonitoring('已通过 Esc 紧急停止。');
    }, true);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.running) {
        log('页面进入后台；浏览器可能降低定时器频率，建议保持此标签页可见。');
      }
    });
  }

  function validateConfig(config, requireAuthorization) {
    const courses = activeCourseConfigs(config);
    courses.forEach((course, index) => {
      if (!course.courseName) throw new Error(`必须填写第 ${index + 1} 门课程的课程名称。`);
    });
    if (config.intervalMs < 3000) throw new Error('刷新间隔不能低于 3 秒。');
    if (requireAuthorization && !ui.arm.checked) {
      throw new Error('开始自动监控前，请勾选“本次授权”。');
    }
  }

  async function queryOnceManually() {
    if (state.running || state.inFlight) {
      toast('当前正在运行，请先停止');
      return;
    }
    try {
      const config = saveConfig(readConfigFromPanel());
      writeConfigToPanel(config);
      validateConfig(config, false);
      const courses = activeCourseConfigs(config);
      state.stopRequested = false;
      state.inFlight = true;
      ensureAudioContext();
      const doc = await enterFreeCoursePage();
      ui.runState.textContent = courses.length > 1 ? '单轮查询' : '查询中';
      ui.runState.className = 'cau-cw-running';
      updateButtons();
      for (let index = 0; index < courses.length; index += 1) {
        if (index > 0 && !(await waitForSharedInterval(config))) break;
        if (state.stopRequested) break;
        const courseConfig = courses[index];
        state.attempts += 1;
        ui.attempts.textContent = `${state.attempts} 次`;
        ui.next.textContent = '查询中';
        ui.result.textContent = `正在查询 ${targetLabel(courseConfig)}`;
        const rows = await performQuery(doc, courseConfig);
        state.lastRows = rows;
        renderQuerySummary(rows, courseConfig);
      }
      if (!state.stopRequested && courses.length > 1) log(`已完成 ${courses.length} 门课程的单轮查询。`, 'success');
    } catch (error) {
      handleFatal(error, '单次查询失败', false);
    } finally {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      state.nextRunAt = 0;
      state.inFlight = false;
      state.stopRequested = false;
      ui.runState.textContent = '已停止';
      ui.runState.className = 'cau-cw-paused';
      ui.next.textContent = '—';
      updateButtons();
    }
  }

  async function waitForSharedInterval(config) {
    const jitter = Math.floor(Math.random() * (config.jitterMs + 1));
    state.nextRunAt = Date.now() + config.intervalMs + jitter;
    updateCountdown();
    clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(updateCountdown, 250);
    while (Date.now() < state.nextRunAt) {
      if (state.stopRequested) return false;
      await sleep(Math.min(150, Math.max(20, state.nextRunAt - Date.now())));
    }
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    state.nextRunAt = 0;
    return !state.stopRequested;
  }

  async function startMonitoring() {
    if (state.running || state.inFlight) return;
    try {
      const config = saveConfig(readConfigFromPanel());
      writeConfigToPanel(config);
      validateConfig(config, true);
      ensureAudioContext();
      state.running = true;
      state.attempts = 0;
      state.consecutiveErrors = 0;
      state.transientFailures = 0;
      state.courseIndex = 0;
      state.stopRequested = false;
      ui.runState.textContent = '运行中';
      ui.runState.className = 'cau-cw-running';
      ui.result.textContent = '等待首次查询';
      const courses = activeCourseConfigs(config);
      log(`开始${config.mode === 'multi' ? `轮询 ${courses.length} 门课程：${courses.map((course) => `“${course.courseName}”`).join('、')}` : `监控“${courses[0].courseName}”`}，共享基础间隔 ${formatSeconds(config.intervalMs)}。`, 'success');
      updateButtons();
      scheduleNext(0);
    } catch (error) {
      toast(error.message, true);
      log(error.message, 'error');
    }
  }

  function pauseMonitoring(reason, options = {}) {
    state.stopRequested = true;
    clearTimeout(state.timer);
    clearInterval(state.countdownTimer);
    state.timer = null;
    state.countdownTimer = null;
    state.running = false;
    state.nextRunAt = 0;
    if (ui) {
      ui.runState.textContent = options.success ? '已成功' : '已停止';
      ui.runState.className = 'cau-cw-paused';
      ui.next.textContent = '—';
      log(reason, options.success ? 'success' : options.error ? 'error' : '');
      updateButtons();
    }
  }

  function updateButtons() {
    if (!ui) return;
    ui.start.disabled = state.running || state.inFlight;
    ui.pause.disabled = (!state.running && !state.inFlight) || state.stopRequested;
    field('cau-cw-query').disabled = state.running || state.inFlight;
    updateCourseControls();
  }

  function scheduleNext(delayOverride = null) {
    if (!state.running) return;
    clearTimeout(state.timer);
    clearInterval(state.countdownTimer);
    const jitter = Math.floor(Math.random() * (state.config.jitterMs + 1));
    const errorBackoff = Math.min(60000, state.consecutiveErrors * state.consecutiveErrors * 1500);
    const transientBackoff = Math.min(15000, state.transientFailures * 2500);
    const delay = delayOverride ?? (state.config.intervalMs + jitter + errorBackoff + transientBackoff);
    state.nextRunAt = Date.now() + delay;
    updateCountdown();
    state.countdownTimer = setInterval(updateCountdown, 250);
    state.timer = setTimeout(() => {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      tick();
    }, delay);
  }

  function updateCountdown() {
    if ((!state.running && !state.inFlight) || !state.nextRunAt) {
      if (ui) ui.next.textContent = '—';
      return;
    }
    const seconds = Math.max(0, (state.nextRunAt - Date.now()) / 1000);
    ui.next.textContent = `${seconds.toFixed(1)} 秒`;
  }

  async function tick() {
    if (!state.running || state.inFlight || state.stopRequested) return;
    if (state.config.maxAttempts > 0 && state.attempts >= state.config.maxAttempts) {
      pauseMonitoring(`已达到最多查询次数（${state.config.maxAttempts}），监控停止。`);
      return;
    }

    state.inFlight = true;
    state.attempts += 1;
    ui.attempts.textContent = `${state.attempts} 次`;
    ui.next.textContent = '查询中';
    updateButtons();

    const courses = activeCourseConfigs(state.config);
    if (state.courseIndex >= courses.length) state.courseIndex = 0;
    const courseConfig = courses[state.courseIndex];

    try {
      const doc = await enterFreeCoursePage();
      ui.result.textContent = `正在查询 ${targetLabel(courseConfig)}`;
      const rows = await performQuery(doc, courseConfig);
      state.lastRows = rows;
      state.consecutiveErrors = 0;
      renderQuerySummary(rows, courseConfig);
      if (!state.running || state.stopRequested) return;

      const eligible = chooseEligibleRows(rows, courseConfig);
      if (!eligible.length) {
        state.transientFailures = 0;
        advanceCourseIndex();
        scheduleNext();
        return;
      }

      const target = eligible[0];
      const descriptor = describeRow(target);
      if (eligible.length > 1) {
        log(`${targetLabel(courseConfig)}：发现 ${eligible.length} 个有余量的匹配班级，将按“${strategyLabel(courseConfig.selectionStrategy)}”选择：${descriptor}`);
      } else {
        log(`${targetLabel(courseConfig)}：发现余量，准备选择：${descriptor}`, 'success');
      }

      if (isAlreadySelected(target)) {
        finishSuccess(`检测到目标班级已经在选课结果中：${descriptor}`);
        return;
      }

      const result = await selectCourse(target);
      if (result === 'retry') {
        state.transientFailures += 1;
        advanceCourseIndex();
        scheduleNext();
      }
    } catch (error) {
      state.consecutiveErrors += 1;
      log(`第 ${state.attempts} 次查询异常：${friendlyError(error)}`, 'error');
      if (isSessionError(error)) {
        handleFatal(error, '登录会话可能已失效');
      } else if (state.consecutiveErrors >= 5) {
        handleFatal(error, '连续 5 次查询异常，已为保护账号而暂停');
      } else {
        ui.result.textContent = `异常 ${state.consecutiveErrors} 次`;
        advanceCourseIndex();
        scheduleNext();
      }
    } finally {
      state.inFlight = false;
      updateButtons();
    }
  }

  function advanceCourseIndex() {
    const count = activeCourseConfigs(state.config).length;
    state.courseIndex = count > 0 ? (state.courseIndex + 1) % count : 0;
  }

  function getMainFrame() {
    return PAGE.document.getElementById('mainFrame');
  }

  function getFrameDocument() {
    const frame = getMainFrame();
    if (!frame) throw new Error('找不到选课内容框架 mainFrame。');
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (!doc) throw new Error('选课框架尚未加载。');
      return doc;
    } catch (error) {
      throw new Error('无法读取选课内容，可能已跳转到登录页或页面结构发生变化。', { cause: error });
    }
  }

  function pageLooksLoggedOut(doc) {
    let path = '';
    try { path = doc.location.pathname; } catch (_) { return true; }
    return Boolean(
      doc.querySelector('#userAccount, input[name="userAccount"]') ||
      /\/login/i.test(path) ||
      /欢迎登录|请先登录系统/.test(normalize(doc.body?.innerText).slice(0, 600))
    );
  }

  function isFreeCoursePage(doc) {
    let path = '';
    try { path = doc.location.pathname; } catch (_) { return false; }
    return /\/jsxsd\/xsxkkc\/comeInFawxk$/.test(path) && Boolean(doc.querySelector('#kcxx'));
  }

  async function enterFreeCoursePage() {
    let doc = getFrameDocument();
    if (pageLooksLoggedOut(doc)) throw new Error('登录会话已失效，请重新登录后再开始。');
    if (isFreeCoursePage(doc)) {
      updatePageStatus('自由选课', true);
      return doc;
    }

    const link = document.querySelector('a[href*="comeInFawxk"]');
    if (!link) throw new Error('找不到顶部“自由选课”入口。');
    updatePageStatus('正在切换', false);
    link.click();
    doc = await waitUntil(() => {
      const candidate = getFrameDocument();
      if (pageLooksLoggedOut(candidate)) throw new Error('切换页面时登录会话失效。');
      return isFreeCoursePage(candidate) ? candidate : null;
    }, 12000, 150);
    updatePageStatus('自由选课', true);
    return doc;
  }

  function updatePageStatus(label = null, ok = null) {
    if (!ui) return;
    if (label) {
      ui.pageState.textContent = label;
      ui.pageState.style.color = ok ? '#087333' : '#8a6410';
      return;
    }
    try {
      const doc = getFrameDocument();
      if (pageLooksLoggedOut(doc)) return updatePageStatus('需要登录', false);
      if (isFreeCoursePage(doc)) return updatePageStatus('自由选课', true);
      updatePageStatus('其他选课页', false);
    } catch (_) {
      updatePageStatus('未就绪', false);
    }
  }

  function setInputValue(element, value) {
    element.value = value;
    const EventConstructor = element.ownerDocument.defaultView.Event;
    element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  }

  function findQueryButton(doc) {
    return [...doc.querySelectorAll('input[type="button"], button')]
      .find((element) => normalize(element.value || element.textContent) === '查询');
  }

  function isElementVisible(element) {
    if (!element) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  async function performQuery(doc, config) {
    if (pageLooksLoggedOut(doc)) throw new Error('登录会话已失效，请重新登录。');
    const input = doc.querySelector('#kcxx');
    const button = findQueryButton(doc);
    if (!input || !button) throw new Error('找不到课程输入框或查询按钮，页面结构可能已变化。');

    setInputValue(input, config.courseName);
    const hideFullCheckbox = doc.querySelector('#sfym');
    if (config.showFullCourses && hideFullCheckbox?.checked) {
      hideFullCheckbox.checked = false;
      const EventConstructor = hideFullCheckbox.ownerDocument.defaultView.Event;
      hideFullCheckbox.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    }

    const queryStartedAt = performance.now();
    button.click();
    await sleep(280);
    await waitUntil(() => {
      if (pageLooksLoggedOut(doc)) throw new Error('查询过程中登录会话失效。');
      const table = doc.querySelector('#dataView');
      if (!table) return false;
      const processing = doc.querySelector('#dataView_processing');
      if (isElementVisible(processing)) return false;
      const info = doc.querySelector('#dataView_info');
      const bodyRows = table.querySelectorAll('tbody tr');
      return Boolean(info && bodyRows.length > 0 && performance.now() - queryStartedAt >= 350);
    }, 15000, 120);

    const rows = parseCourseRows(doc);
    log(`第 ${state.attempts || 1} 次查询完成：${targetLabel(config)}，返回 ${rows.length} 个班级。`);
    return rows;
  }

  function parseCourseRows(doc) {
    const table = doc.querySelector('#dataView');
    if (!table) throw new Error('查询结束后未找到课程表。');
    const headers = [...table.querySelectorAll('thead th')].map((cell) => normalize(cell.textContent));
    const indexOf = (name) => headers.findIndex((header) => header.includes(name));
    const indexes = {
      noticeId: indexOf('通知单号'),
      courseCode: indexOf('课程编号'),
      courseName: indexOf('课程名'),
      classNumber: indexOf('课序号'),
      teacher: indexOf('上课教师'),
      time: indexOf('上课时间'),
      campus: indexOf('上课校区'),
      remaining: indexOf('剩余容量'),
      operation: indexOf('操作'),
    };
    const required = ['noticeId', 'courseCode', 'courseName', 'remaining', 'operation'];
    if (required.some((key) => indexes[key] < 0)) {
      throw new Error(`课程表列与预期不符：${headers.join('、')}`);
    }

    return [...table.querySelectorAll('tbody tr')].flatMap((row, order) => {
      const cells = [...row.cells];
      if (!cells.length || row.querySelector('.dataTables_empty')) return [];
      const textAt = (key) => indexes[key] >= 0 ? normalize(cells[indexes[key]]?.innerText) : '';
      const remainingText = textAt('remaining');
      const match = remainingText.match(/-?\d+/);
      const remaining = match ? Number(match[0]) : Number.NaN;
      const operationCell = cells[indexes.operation];
      const selectLink = operationCell?.querySelector('a[href*="xsxkFun"], a[onclick*="xsxkFun"]') || null;
      return [{
        row,
        order,
        noticeId: textAt('noticeId'),
        courseCode: textAt('courseCode'),
        courseName: textAt('courseName'),
        classNumber: textAt('classNumber'),
        teacher: textAt('teacher'),
        time: textAt('time'),
        campus: textAt('campus'),
        remaining,
        remainingText,
        selectLink,
      }];
    });
  }

  function rowMatches(row, config) {
    const expectedName = compact(config.courseName);
    const actualName = compact(row.courseName);
    const numericSuffix = /[（(][0-9一二三四五六七八九十]+[)）]$/u;
    const nameMatches = config.matchMode === 'contains'
      ? actualName.includes(expectedName)
      : actualName === expectedName ||
        (!numericSuffix.test(expectedName) && actualName.replace(numericSuffix, '') === expectedName);
    if (!nameMatches) return false;
    if (config.courseCode && compact(row.courseCode) !== compact(config.courseCode)) return false;
    if (config.teacher && !compact(row.teacher).includes(compact(config.teacher))) return false;
    if (config.classNumber && compact(row.classNumber) !== compact(config.classNumber)) return false;
    if (config.campus && !compact(row.campus).includes(compact(config.campus))) return false;
    if (config.timeKeyword && !compact(row.time).includes(compact(config.timeKeyword))) return false;
    return true;
  }

  function matchingRows(rows, config) {
    return rows.filter((row) => rowMatches(row, config));
  }

  function chooseEligibleRows(rows, config) {
    const eligible = matchingRows(rows, config)
      .filter((row) => Number.isFinite(row.remaining) && row.remaining >= config.minRemaining && row.selectLink);
    if (config.selectionStrategy === 'maxRemaining') {
      eligible.sort((a, b) => (b.remaining - a.remaining) || (a.order - b.order));
    } else {
      eligible.sort((a, b) => a.order - b.order);
    }
    return eligible;
  }

  function renderQuerySummary(rows, config) {
    const matches = matchingRows(rows, config);
    const prefix = activeCourseConfigs(state.config).length > 1 ? `第 ${config.targetIndex + 1} 门：` : '';
    if (!matches.length) {
      ui.result.textContent = `${prefix}没有匹配课程`;
      log(`${targetLabel(config)}：本次没有找到符合全部条件的课程。`);
      return;
    }
    const available = matches.filter((row) => Number.isFinite(row.remaining) && row.remaining >= config.minRemaining && row.selectLink);
    if (available.length) {
      const max = Math.max(...available.map((row) => row.remaining));
      ui.result.textContent = `${prefix}${available.length} 班有余量（最多 ${max}）`;
    } else {
      const capacities = matches.map((row) => row.remainingText || '?').join(', ');
      ui.result.textContent = `${prefix}${matches.length} 班匹配，余量 ${capacities}`;
    }
  }

  function strategyLabel(strategy) {
    return strategy === 'first' ? '页面中的第一班' : '剩余容量最多';
  }

  function describeRow(row) {
    const parts = [row.courseName];
    if (row.classNumber) parts.push(`课序号 ${row.classNumber}`);
    if (row.teacher) parts.push(row.teacher);
    parts.push(`余量 ${row.remainingText || '?'}`);
    return parts.join(' / ');
  }

  function isAlreadySelected(target) {
    try {
      const kbDoc = PAGE.document.getElementById('kbFrame')?.contentDocument;
      if (!kbDoc) return false;
      return [...kbDoc.querySelectorAll('tr')].some((row) => {
        const firstCell = normalize(row.cells?.[0]?.innerText);
        return firstCell === target.noticeId && /选中|退选/.test(normalize(row.innerText));
      });
    } catch (_) {
      return false;
    }
  }

  async function verifySelected(target, timeoutMs = 10000) {
    try {
      return await waitUntil(() => isAlreadySelected(target), timeoutMs, 300);
    } catch (_) {
      return false;
    }
  }

  function captchaIsVisible(doc) {
    return isElementVisible(doc.querySelector('#verifyCodeDiv'));
  }

  function parseSelectionArguments(target) {
    const link = target.selectLink;
    const source = `${link?.getAttribute('href') || ''} ${link?.getAttribute('onclick') || ''}`;
    const match = source.match(
      /xsxkFun\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]*)['"]\s*\)/,
    );
    if (!match) throw new Error('无法安全解析页面原生选课参数，已停止而不会猜测参数。');
    const args = { jx0404id: match[1], kcid: match[2], cfbs: match[3] };
    if (args.jx0404id !== target.noticeId) {
      throw new Error('选课按钮参数与当前课程通知单号不一致，已停止。');
    }
    return args;
  }

  function ensurePageSelectionBridge(doc) {
    let bridge = doc.getElementById(BRIDGE_ID);
    if (!bridge) {
      bridge = doc.createElement('span');
      bridge.id = BRIDGE_ID;
      bridge.hidden = true;
      (doc.body || doc.documentElement).appendChild(bridge);
    }
    if (bridge.dataset.installed === '1') return bridge;

    // Tampermonkey 带 @grant 时运行在隔离环境。把这段固定代码注入页面环境，
    // 才能可靠调用学校页面自己的全局函数，并截获同一环境中的 alert/confirm。
    const script = doc.createElement('script');
    script.textContent = `(() => {
      'use strict';
      const bridgeId = ${JSON.stringify(BRIDGE_ID)};
      const requestEvent = ${JSON.stringify(BRIDGE_REQUEST_EVENT)};
      const responseEvent = ${JSON.stringify(BRIDGE_RESPONSE_EVENT)};
      const bridge = document.getElementById(bridgeId);
      if (!bridge || bridge.dataset.installed === '1') return;
      bridge.dataset.installed = '1';
      bridge.addEventListener(requestEvent, () => {
        if (bridge.dataset.busy === '1') return;
        bridge.dataset.busy = '1';
        const token = bridge.dataset.token || '';
        const jx0404id = bridge.dataset.jx0404id || '';
        const kcid = bridge.dataset.kcid || '';
        const cfbs = bridge.dataset.cfbs || '';
        const mode = bridge.dataset.mode || '';
        const allowedRequired = /^[A-Za-z0-9_-]{1,128}$/;
        const allowedOptional = /^[A-Za-z0-9_-]{0,128}$/;
        const messages = [];
        const confirmations = [];
        const originalAlert = window.alert;
        const originalConfirm = window.confirm;
        let error = '';
        try {
          if (!allowedRequired.test(jx0404id) || !allowedRequired.test(kcid) || !allowedOptional.test(cfbs)) {
            throw new Error('选课参数未通过安全校验');
          }
          window.alert = (message) => messages.push(String(message ?? ''));
          if (mode === 'auto-confirm-all') {
            window.confirm = (message) => {
              confirmations.push(String(message ?? ''));
              return true;
            };
          }
          if (typeof window.xsxkFun !== 'function') {
            throw new Error('页面原生 xsxkFun 函数不存在');
          }
          window.xsxkFun(jx0404id, kcid, cfbs);
        } catch (caught) {
          error = caught && caught.message ? String(caught.message) : String(caught);
        } finally {
          window.alert = originalAlert;
          window.confirm = originalConfirm;
          bridge.dataset.result = JSON.stringify({ token, messages, confirmations, error });
          bridge.dataset.busy = '0';
          bridge.dispatchEvent(new Event(responseEvent));
        }
      });
    })();`;
    (doc.head || doc.documentElement).appendChild(script);
    script.remove();

    if (bridge.dataset.installed !== '1') {
      throw new Error('页面安全策略阻止了选课桥接代码，无法可靠自动处理确认框。');
    }
    return bridge;
  }

  function invokeNativeSelection(doc, args, autoConfirmAll) {
    const bridge = ensurePageSelectionBridge(doc);
    if (bridge.dataset.busy === '1') {
      throw new Error('页面原生选课流程仍在执行，请稍后再试。');
    }
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    bridge.dataset.token = token;
    bridge.dataset.jx0404id = args.jx0404id;
    bridge.dataset.kcid = args.kcid;
    bridge.dataset.cfbs = args.cfbs;
    bridge.dataset.mode = autoConfirmAll ? 'auto-confirm-all' : 'normal';
    bridge.dataset.result = '';

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        bridge.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
        callback();
      };
      const onResponse = () => {
        let result;
        try {
          result = JSON.parse(bridge.dataset.result || '{}');
        } catch (error) {
          finish(() => reject(new Error(`无法读取页面选课结果：${friendlyError(error)}`)));
          return;
        }
        if (result.token !== token) return;
        finish(() => {
          if (result.error) reject(new Error(result.error));
          else resolve({
            messages: Array.isArray(result.messages) ? result.messages.map(normalize) : [],
            confirmations: Array.isArray(result.confirmations) ? result.confirmations.map(normalize) : [],
          });
        });
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error('页面原生选课流程 60 秒内没有返回结果。')));
      }, 60000);
      bridge.addEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
      const EventConstructor = doc.defaultView.Event;
      bridge.dispatchEvent(new EventConstructor(BRIDGE_REQUEST_EVENT));
    });
  }

  async function selectCourse(target) {
    const link = target.selectLink;
    if (!link?.isConnected) throw new Error('选课按钮已失效，课程表可能刚刚刷新。');
    const doc = link.ownerDocument;
    const args = parseSelectionArguments(target);
    let outcome;

    try {
      if (state.config.autoConfirmAllPrompts) {
        log('已按本次授权启用本次选课流程的全部“确定”弹窗自动确认。');
      } else {
        log('正在调用学校原生选课流程，请手动处理全部确认框。');
      }
      outcome = await invokeNativeSelection(doc, args, state.config.autoConfirmAllPrompts);
      outcome.confirmations.forEach((text) => {
        log(`已自动点击“确定”：${text}`);
      });
      outcome.messages.forEach((text) => {
        log(`教务系统返回：${text}`, /成功|已选/.test(text) ? 'success' : '');
      });
    } catch (error) {
      throw new Error(`调用页面原生选课流程失败：${friendlyError(error)}`);
    }

    await sleep(450);
    if (captchaIsVisible(doc)) {
      const message = '教务系统要求验证码。脚本已暂停，请在页面中手动完成验证码，然后重新开始监控。';
      pauseMonitoring(message, { error: true });
      importantNotice('需要手动验证码', message);
      return 'stop';
    }

    const combined = outcome.messages.join('；');
    if (/请先登录|重新登录|登录超时|会话.*失效/.test(combined)) {
      const error = new Error(combined || '登录会话已失效。');
      handleFatal(error, '登录会话已失效');
      return 'stop';
    }

    const responseSaysSuccess = /选课成功|成功选上|操作成功|已选中|已经选择|已选过|重复选择/.test(combined);
    const verified = await verifySelected(target, responseSaysSuccess ? 3000 : 10000);
    if (verified || responseSaysSuccess) {
      finishSuccess(`选课成功：${describeRow(target)}${combined ? `；系统消息：${combined}` : ''}`);
      return 'success';
    }

    if (/已满|容量不足|没有余量|无课余量|余量不足|名额.*满|人数.*满/.test(combined)) {
      log('余量在提交时被其他人占用，将退避后继续监控。');
      ui.result.textContent = '提交时已满，继续监控';
      return 'retry';
    }

    const message = combined || '页面没有给出可验证的成功结果；为避免重复提交，已暂停。请先查看“选课结果查看及退选”。';
    pauseMonitoring(`选课结果不确定或不可重试：${message}`, { error: true });
    importantNotice('选课助手已暂停', message);
    return 'stop';
  }

  function finishSuccess(message) {
    ui.result.textContent = '选课成功';
    pauseMonitoring(message, { success: true });
    importantNotice('选课成功', message, true);
  }

  function isSessionError(error) {
    return /登录|会话|userAccount|跨域/.test(friendlyError(error));
  }

  function friendlyError(error) {
    if (!error) return '未知错误';
    return normalize(error.message || error);
  }

  function handleFatal(error, prefix, stopRunning = true) {
    const message = `${prefix}：${friendlyError(error)}`;
    if (stopRunning && state.running) pauseMonitoring(message, { error: true });
    else log(message, 'error');
    ui.result.textContent = prefix;
    importantNotice(prefix, message);
  }

  function formatSeconds(ms) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  }

  function timeLabel() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function log(message, level = '') {
    if (!ui) return;
    const item = document.createElement('li');
    if (level) item.className = level;
    item.textContent = `[${timeLabel()}] ${message}`;
    ui.log.appendChild(item);
    while (ui.log.children.length > 120) ui.log.firstElementChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    document.getElementById(`${SCRIPT_ID}-toast`)?.remove();
    clearTimeout(toastTimer);
    const element = document.createElement('div');
    element.id = `${SCRIPT_ID}-toast`;
    element.textContent = message;
    if (isError) element.style.background = '#a63d35';
    document.body.appendChild(element);
    toastTimer = setTimeout(() => element.remove(), 4200);
  }

  function ensureAudioContext() {
    if (!state.config.sound || state.audioContext) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) state.audioContext = new AudioContext();
    } catch (_) {
      // 音频不可用不影响核心功能。
    }
  }

  function beep(success = false) {
    if (!state.config.sound) return;
    ensureAudioContext();
    const context = state.audioContext;
    if (!context) return;
    try {
      if (context.state === 'suspended') context.resume();
      const frequencies = success ? [660, 880, 1100] : [780, 520, 780];
      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + index * 0.18;
        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.16);
      });
    } catch (_) {
      // 提示音失败不影响通知和日志。
    }
  }

  function importantNotice(title, message, success = false) {
    toast(`${title}：${message}`, !success);
    beep(success);
    if (!state.config.desktopNotification) return;
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title, text: message, timeout: 12000 });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body: message });
      }
    } catch (error) {
      log(`桌面通知发送失败：${friendlyError(error)}`);
    }
  }

  function init() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    createPanel();
    setInterval(updatePageStatus, 2500);
  }

  init();
})();
