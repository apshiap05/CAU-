'use strict';

const TARGET_URL =
  'https://newjw.cau.edu.cn/jsxsd/xsxk/xsxk_index?jx0502zbid=0462E4F330FA473A906C50B1B431E208';

document.getElementById('open-page').addEventListener('click', async () => {
  await chrome.tabs.create({ url: TARGET_URL });
  window.close();
});
