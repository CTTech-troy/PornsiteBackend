import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  normalizeEnterpriseVideoRow,
  parseRawSemicolonVideoRow,
  streamEnterpriseCsvRowsFromStream,
} from '../../src/services/enterpriseCsvParser.service.js';

test('enterprise parser maps raw semicolon CSV and preserves iframe field', () => {
  const line = 'https://www.videos.com/video.oobplof3a4e/steamy_japanese_home_porn_action_on_the_couch_with_marie_konno;Steamy Japanese Home Porn Action On The Couch With Marie Konno;470 sec;https://thumb-cdn77.others-cdn.com/7f89eedd-4ce2-4187-88fb-bb591bb9faee/3/xv_15_t.jpg;<iframe src="https://www.videos.com/embedframe/oobplof3a4e"></iframe>;sex,asian,japanese,jav,japanese-milf;Erina Takigawa,Hidemi Katada;89876575;asian_woman;720P;Jav HD;;2026-05-21;;0';
  const raw = parseRawSemicolonVideoRow(line);
  const result = normalizeEnterpriseVideoRow(raw);

  assert.equal(raw.iframe_embed, '<iframe src="https://www.videos.com/embedframe/oobplof3a4e"></iframe>');
  assert.equal(result.error, undefined);
  assert.equal(result.row.iframe_embed, '<iframe src="https://www.videos.com/embedframe/oobplof3a4e"></iframe>');
  assert.equal(result.row.playback_type, 'external_embed');
  assert.equal(result.row.video_url, 'https://www.videos.com/video.oobplof3a4e/steamy_japanese_home_porn_action_on_the_couch_with_marie_konno');
  assert.equal(result.row.title, 'Steamy Japanese Home Porn Action On The Couch With Marie Konno');
  assert.equal(result.row.duration, 470);
  assert.equal(result.row.thumbnail_url, 'https://thumb-cdn77.others-cdn.com/7f89eedd-4ce2-4187-88fb-bb591bb9faee/3/xv_15_t.jpg');
  assert.deepEqual(result.row.tags, ['sex', 'asian', 'japanese', 'jav', 'japanese-milf']);
  assert.deepEqual(result.row.actors, ['Erina Takigawa', 'Hidemi Katada']);
  assert.equal(result.row.views, 89876575);
  assert.equal(result.row.category, 'asian_woman');
  assert.equal(result.row.quality, '720P');
  assert.equal(result.row.studio, 'Jav HD');
  assert.equal(result.row.publish_date, '2026-05-21');
});

test('enterprise parser supports headered CSV and imports iframe-like metadata into iframe_embed', async () => {
  const csv = [
    'video_url,title,duration,thumbnail_url,tags,actors,views,category,quality,studio,publish_date,iframe_html,extra',
    '"https://example.com/watch/1","Title <b>One</b>","1:02","[https://cdn.example.com/thumb.jpg](https://cdn.example.com/thumb.jpg)","a,b","Actor A|Actor B","1,200","cat","1080P","Studio","2026-05-21","<iframe src=""https://bad.example.com""></iframe>","<strong>keep</strong>"',
  ].join('\n');
  const rows = [];
  for await (const row of streamEnterpriseCsvRowsFromStream(Readable.from(`${csv}\n`))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, undefined);
  assert.equal(rows[0].row.title, 'Title One');
  assert.equal(rows[0].row.thumbnail_url, 'https://cdn.example.com/thumb.jpg');
  assert.deepEqual(rows[0].row.tags, ['a', 'b']);
  assert.deepEqual(rows[0].row.actors, ['Actor A', 'Actor B']);
  assert.equal(rows[0].row.views, 1200);
  assert.equal(rows[0].row.iframe_embed, '<iframe src="https://bad.example.com"></iframe>');
  assert.equal(rows[0].row.playback_type, 'external_embed');
  assert.equal(rows[0].row.metadata.extra, 'keep');
  assert.equal(JSON.stringify(rows[0].row.metadata).includes('<iframe'), false);
});

test('enterprise parser defaults to semicolon delimiter and preserves quoted semicolons', async () => {
  const csv = [
    'video_url;title;duration;thumbnail_url;tags;actors;views;category;quality;studio;publish_date',
    '"https://example.com/watch/2";"Title with ; semicolon";"70 sec";"https://cdn.example.com/thumb2.jpg";"alpha;beta";"Actor A;Actor B";"2400";"cat";"720P";"Studio";"2026-05-22"',
  ].join('\n');
  const rows = [];
  for await (const row of streamEnterpriseCsvRowsFromStream(Readable.from(`${csv}\n`))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, undefined);
  assert.equal(rows[0].row.title, 'Title with ; semicolon');
  assert.deepEqual(rows[0].row.tags, ['alpha', 'beta']);
  assert.deepEqual(rows[0].row.actors, ['Actor A', 'Actor B']);
  assert.equal(rows[0].row.views, 2400);
});

test('enterprise parser reports malformed rows while retaining iframe field in raw parse output', async () => {
  const rows = [];
  for await (const row of streamEnterpriseCsvRowsFromStream(Readable.from('not-a-url;Bad Row;;;<iframe src="https://bad.example.com"></iframe>;;;;\n'))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, 'MISSING_VIDEO_URL');
  assert.equal(rows[0].raw.iframe_embed, '<iframe src="https://bad.example.com"></iframe>');
});
