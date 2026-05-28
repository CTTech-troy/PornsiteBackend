import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  normalizeImportRow,
  parseRawSemicolonRow,
  streamCsvRowsFromStream,
} from '../../src/services/videoImportCsv.service.js';

test('normalizeImportRow accepts embed URL', () => {
  const result = normalizeImportRow({
    title: 'Sample Video',
    embed_url: 'https://www.youtube.com/embed/abc123',
    tags: 'a,b,c',
    duration: '120',
    premium: 'true',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.row.title, 'Sample Video');
  assert.equal(result.row.embed_url, 'https://www.youtube.com/embed/abc123');
  assert.equal(result.row.tags.length, 3);
  assert.equal(result.row.is_premium_content, true);
});

test('normalizeImportRow rejects missing URL', () => {
  const result = normalizeImportRow({ title: 'No URL' });
  assert.equal(result.error, 'MISSING_URL');
});

test('normalizeImportRow accepts media_file without embed', () => {
  const result = normalizeImportRow({
    title: 'Local',
    media_file: 'clips/video.mp4',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.row.media_file, 'clips/video.mp4');
});

test('normalizeImportRow extracts iframe src and removes HTML', () => {
  const result = normalizeImportRow({
    title: '<b>Sample Video</b>',
    description: '<p>Clean description</p>',
    embed_url: '<iframe src="https://www.youtube.com/embed/abc123?rel=0&amp;autoplay=0" width="560"></iframe>',
    metadata: JSON.stringify({
      embed: '<iframe src="https://player.vimeo.com/video/12345"></iframe>',
      note: '<strong>Keep text only</strong>',
    }),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.row.title, 'Sample Video');
  assert.equal(result.row.description, 'Clean description');
  assert.equal(result.row.embed_url, 'https://www.youtube.com/embed/abc123?rel=0&autoplay=0');
  assert.equal(result.row.stream_url, null);
  assert.equal(result.row.metadata.embed, 'https://player.vimeo.com/video/12345');
  assert.equal(result.row.metadata.note, 'Keep text only');
  assert.equal(result.row.metadata.importSource.kind, 'official_embed');
  assert.equal(result.row.metadata.importSource.htmlStripped, true);
});

test('normalizeImportRow stores direct video aliases as stream URL', () => {
  const result = normalizeImportRow({
    title: 'Direct stream',
    embed_url: 'https://example.supabase.co/storage/v1/object/public/videos/direct.mp4',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.row.embed_url, null);
  assert.equal(result.row.stream_url, 'https://example.supabase.co/storage/v1/object/public/videos/direct.mp4');
  assert.equal(result.row.metadata.importSource.kind, 'direct_stream');
});

test('parseRawSemicolonRow maps raw video rows and removes iframe field', () => {
  const rawLine = 'https://www.videos.com/video.oobplof3a4e/steamy_japanese_home_action_on_the_couch_with_marie_konno;Steamy Japanese Home Action On The Couch With Marie Konno;470 sec;https://thumb-cdn77.others-cdn.com/7f89eedd-4ce2-4187-88fb-bb591bb9faee/3/xv_15_t.jpg;<iframe src="https://www.videos.com/embedframe/oobplof3a4e" frameborder=0 width=510 height=400 scrolling=no allowfullscreen=allowfullscreen></iframe>;sex,asian,japanese,jav,japanese-milf;Erina Takigawa,Hidemi Katada;89876575;asian_woman;720P;Jav HD;;2026-05-21;;0';
  const raw = parseRawSemicolonRow(rawLine);
  const result = normalizeImportRow(raw);

  assert.equal(raw.video_url, 'https://www.videos.com/video.oobplof3a4e/steamy_japanese_home_action_on_the_couch_with_marie_konno');
  assert.equal(raw.title, 'Steamy Japanese Home Action On The Couch With Marie Konno');
  assert.equal(raw.duration, '470 sec');
  assert.equal(raw.thumbnail, 'https://thumb-cdn77.others-cdn.com/7f89eedd-4ce2-4187-88fb-bb591bb9faee/3/xv_15_t.jpg');
  assert.equal(JSON.stringify(raw).includes('<iframe'), false);
  assert.equal(result.error, undefined);
  assert.equal(result.row.duration_seconds, 470);
  assert.equal(result.row.embed_url, null);
  assert.equal(result.row.stream_url, null);
  assert.equal(result.row.metadata.importSource.url, raw.video_url);
  assert.equal(result.row.metadata.importSource.kind, 'external_page');
  assert.deepEqual(result.row.metadata.actors, ['Erina Takigawa', 'Hidemi Katada']);
  assert.equal(result.row.metadata.views, 89876575);
  assert.equal(result.row.metadata.quality, '720P');
  assert.equal(result.row.metadata.studio, 'Jav HD');
  assert.equal(result.row.metadata.created_at.startsWith('2026-05-21'), true);
});

test('streamCsvRowsFromStream auto-detects raw semicolon rows without headers', async () => {
  const rawLine = 'https://www.videos.com/video.foo/title;Title One;10 sec;https://thumb.example.com/1.jpg;<iframe src="https://www.videos.com/embedframe/foo"></iframe>;tag1,tag2;Actor One;10;category;720P;Studio;;2026-05-21;;0';
  const rows = [];
  for await (const row of streamCsvRowsFromStream(Readable.from(`${rawLine}\n`))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 1);
  assert.equal(rows[0].row.title, 'Title One');
  assert.equal(rows[0].row.tags.length, 2);
  assert.equal(JSON.stringify(rows[0].raw).includes('<iframe'), false);
});

test('streamCsvRowsFromStream keeps headered CSV compatibility', async () => {
  const csv = [
    'title,embed_url,tags,duration',
    'Headered,https://www.youtube.com/embed/abc123,"a,b",120',
  ].join('\n');
  const rows = [];
  for await (const row of streamCsvRowsFromStream(Readable.from(`${csv}\n`))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].row.title, 'Headered');
  assert.equal(rows[0].row.embed_url, 'https://www.youtube.com/embed/abc123');
  assert.deepEqual(rows[0].row.tags, ['a', 'b']);
});

test('streamCsvRowsFromStream supports headered semicolon CSV', async () => {
  const csv = [
    'title;embed_url;tags;duration',
    'Headered Semi;https://www.youtube.com/embed/xyz789;a,b;90 sec',
  ].join('\n');
  const rows = [];
  for await (const row of streamCsvRowsFromStream(Readable.from(`${csv}\n`))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].row.title, 'Headered Semi');
  assert.equal(rows[0].row.embed_url, 'https://www.youtube.com/embed/xyz789');
  assert.equal(rows[0].row.duration_seconds, 90);
});

test('raw semicolon rows tolerate missing fields and malformed URLs', async () => {
  const rows = [];
  for await (const row of streamCsvRowsFromStream(Readable.from('not-a-url;Bad Row;;;;;;;\n'))) {
    rows.push(row);
  }

  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, 'MISSING_URL');
  assert.equal(JSON.stringify(rows[0].raw).includes('<iframe'), false);
});
