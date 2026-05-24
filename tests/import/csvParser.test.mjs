import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImportRow } from '../../src/services/videoImportCsv.service.js';

test('normalizeImportRow accepts embed URL', () => {
  const result = normalizeImportRow({
    title: 'Sample Video',
    embed_url: 'https://example.com/embed/1',
    tags: 'a,b,c',
    duration: '120',
    premium: 'true',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.row.title, 'Sample Video');
  assert.equal(result.row.embed_url, 'https://example.com/embed/1');
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
