/**
 * 回归测试：`b23.tv` 短链（手机分享出来的链接）不能丢视频基本信息。
 *
 * 2026-10-15 的 bug：yt-dlp 对 B 站给出的 `info.id` 是 `BV<10 位>_p<页码>`，
 * **单 P 视频也带 `_p1`**。这个串不是合法 bvid，`/x/web-interface/view` 直接
 * `code=-400`，于是「作者粉丝数 / 播放量 / 发布时间…」全丢，官方字幕的兜底
 * 请求也一起失效（只能退回慢得多的本地识别）。
 *
 * 跑：`npm test`（或 `node --test test/`）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bareBvid, pageOf, videoParam } from '../bilisum.mjs';

test('bareBvid 剥掉 yt-dlp 的 _pN 后缀', () => {
  assert.equal(bareBvid('BV1eYpZ6LELE_p1'), 'BV1eYpZ6LELE');
  assert.equal(bareBvid('BV1eYpZ6LELE_p12'), 'BV1eYpZ6LELE');
  assert.equal(bareBvid('BV1eYpZ6LELE'), 'BV1eYpZ6LELE');
  assert.equal(bareBvid('  BV1eYpZ6LELE_p3  '), 'BV1eYpZ6LELE');
});

test('bareBvid 只可能会动 BV 前缀，body 一个字符都不能动', () => {
  // BV body 大小写敏感：小写 x 被改成 X 就是另一个视频。
  assert.equal(bareBvid('BV1GJ411x7h7'), 'BV1GJ411x7h7');
  assert.equal(bareBvid('BV1GJ411X7H7'), 'BV1GJ411X7H7');
  assert.equal(bareBvid('bv1eYpZ6LELE_p1'), 'bv1eYpZ6LELE');
});

test('bareBvid 对不合法输入返回 null，交给调用方降级', () => {
  for (const bad of ['', '   ', null, undefined, 'not-a-bv', 'BV1eYpZ6LELE_p', 'BV1eYpZ6LELE_p1_extra', 'BV123']) {
    assert.equal(bareBvid(bad), null, `应拒绝：${String(bad)}`);
  }
});

test('pageOf 认页码，认不出就是第 1 P', () => {
  assert.equal(pageOf('BV1eYpZ6LELE_p1'), 1);
  assert.equal(pageOf('BV1eYpZ6LELE_p7'), 7);
  assert.equal(pageOf('BV1eYpZ6LELE'), 1);
  assert.equal(pageOf(null), 1);
});

test('videoParam 仍然按原样工作（没被这次改动带坏）', () => {
  assert.equal(videoParam('https://www.bilibili.com/video/BV1GJ411x7h7'), 'bvid=BV1GJ411x7h7');
  assert.equal(videoParam('https://www.bilibili.com/video/av12345'), 'aid=12345');
  assert.throws(() => videoParam('https://b23.tv/i97eAZV'), /无法从 URL 里取到视频标识/);
});
