/**
 * 回归测试：**喂给模型的那份转写不许带可点击时间戳**。
 *
 * 2026-11-02 的改动。时间轴原来每行都是：
 *   `<a href="https://www.bilibili.com/video/BV…?t=103">[00:00:03]</a> 正文`
 * 实测（BV1QSxT6GE1p）：时间轴 25,761 字符里有 19,159 是这堆标签（74%），
 * 而模型要的只有"第几秒 + 说了什么"——链接是给人点的，模型读了纯属烧 token。
 * 去标签后同一支片从 25.7k 字符降到 6.6k，输入大约砍一半。
 *
 * 但 `--full` 写给人看的正式转写必须**原样保留**链接：人点得动才有用。
 *
 * 跑：`npm test`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toMarkdown } from '../bilisum.mjs';

const info = {
  bvid: 'BV1QSxT6GE1p',
  title: '测试标题',
  duration: 3725,
  mode: 'subs',
  lang: 'ai-zh',
  page: 1,
  meta: null,
};

const segments = [
  { start: 1, end: 3, text: '第一句' },
  { start: 3723, end: 3725, text: '一小时零两分那句' },
];

test('中间产物（喂模型）不带 <a href>，只有 [hh:mm:ss] + 正文', () => {
  const md = toMarkdown(info, segments, { intermediate: true });
  assert.ok(!md.includes('<a href'), '中间产物里不该出现链接标签');
  assert.ok(md.includes('[00:00:01] 第一句'), '秒数要保留，模型靠它写时间点');
  assert.ok(md.includes('[01:02:03] 一小时零两分那句'), '超过一小时不能写成 00:02:03');
});

test('正式转写（--full，人看）仍然保留可点击时间戳', () => {
  const md = toMarkdown(info, segments, { intermediate: false });
  assert.ok(
    md.includes('<a href="https://www.bilibili.com/video/BV1QSxT6GE1p?t=1">[00:00:01]</a> 第一句'),
    '--full 那份必须还能点',
  );
  assert.ok(md.includes('?t=3723'), '长视频的链接秒数也要对');
});

test('两种写法只差时间轴那一处：标题 / 基本信息 / 评论块完全一致', () => {
  const comments = {
    total: 1,
    fetched: 1,
    list: [{ user: '某人', like: 3, replies: 0, content: '评论一句' }],
  };
  const lean = toMarkdown(info, segments, { intermediate: true, comments });
  const full = toMarkdown(info, segments, { intermediate: false, comments });
  // 去掉时间轴（和中间产物那行用途标注）后两边应当逐字相同
  const strip = (md) => md
    .split('\n')
    .filter((l) => !/^(\[|<a href)/.test(l) && !l.startsWith('- 用途：中间产物'))
    .join('\n');
  assert.equal(strip(lean), strip(full), '除时间轴外不许有别的差异');
  assert.ok(lean.includes('## 视频基本信息') && lean.includes('## 热门评论'));
});

test('长视频：去标签后字符数至少砍掉四成（回归锚点）', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    start: i * 3,
    end: i * 3 + 3,
    text: '这是一句正常的字幕内容，长度大约二十来个字',
  }));
  const lean = toMarkdown(info, many, { intermediate: true }).length;
  const full = toMarkdown(info, many, { intermediate: false }).length;
  assert.ok(lean < full * 0.6, `中间产物应显著更短（lean=${lean}, full=${full}）`);
});
