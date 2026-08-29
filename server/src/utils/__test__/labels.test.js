/**
 * Lightweight, dependency-free test runner (matches the other suites) for
 * the upload label derivation logic. Run with:
 *   npm run test:labels   (from server/)
 */
import { deriveUploadLabel, sanitizeLabel } from '../labels.js';

let failures = 0;
let passed = 0;
function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${message}`);
  } else {
    failures += 1;
    console.error(`  \u2717 ${message}`);
  }
}

console.log('\nFolder upload: every file shares one top-level folder');
assert(
  deriveUploadLabel(['AJMER-Scan/AJMER/one.jpg', 'AJMER-Scan/AJMER/two.jpg', 'AJMER-Scan/notes.pdf'], 'one.jpg') === 'AJMER-Scan',
  'uses the real dropped/selected folder name, not a generated one',
);

console.log('\nZIP upload: extracted files all live under the ZIP\'s own basename');
assert(
  deriveUploadLabel(['photos/batch/a.jpg', 'photos/batch/nested/b.jpg'], 'photos.zip') === 'photos',
  'uses the ZIP\'s name as the project label',
);

console.log('\nLoose files: no shared folder at all -> first uploaded file\'s name');
assert(
  deriveUploadLabel(['small.jpg', 'large.jpg', 'document.pdf'], 'small.jpg') === 'small',
  'falls back to the first uploaded file\'s name, extension stripped',
);
assert(
  deriveUploadLabel(['IMG_0001.jpg'], 'IMG_0001.jpg') === 'IMG_0001',
  'a single loose file also uses its own name (no folder to speak of)',
);

console.log('\nMixed batch: a folder AND loose files together -> no single common folder -> first-file fallback');
assert(
  deriveUploadLabel(['FolderA/one.jpg', 'loose.jpg'], 'FolderA/one.jpg') === 'one',
  'first uploaded file happens to live in a folder -> falls back to *its own basename* (directory part stripped), not the folder name, since there is no single shared top folder across the whole batch',
);

console.log('\nTwo different folders dropped together: no single common top folder');
assert(
  deriveUploadLabel(['FolderA/one.jpg', 'FolderB/two.jpg'], 'FolderA/one.jpg') === 'one',
  'falls back to the first file\'s own basename when top-level folders disagree',
);

console.log('\nIsolation: two uploads of a folder with the *same* name derive the same label independently');
assert(
  deriveUploadLabel(['AJMER/a.jpg'], 'a.jpg') === deriveUploadLabel(['AJMER/b.jpg'], 'b.jpg'),
  'two separate uploads of same-named folders both derive "AJMER" - labels can collide, this is checked separately from on-disk isolation (see zipExtractor/jobManager, which key by a unique job id regardless of label)',
);

console.log('\nsanitizeLabel');
assert(sanitizeLabel('AJMER-Scan') === 'AJMER-Scan', 'leaves an already-clean label untouched');
assert(sanitizeLabel('a/b\\c') === 'a-b-c', 'replaces path separators rather than leaving them in a display label');
assert(sanitizeLabel('  padded  ') === 'padded', 'trims surrounding whitespace');
assert(sanitizeLabel('') === 'Untitled upload', 'falls back to a friendly default for an empty label');
assert(sanitizeLabel(null) === 'Untitled upload', 'falls back to a friendly default for a missing label');
assert(sanitizeLabel('x'.repeat(500)).length === 150, 'caps overly long labels to a sane length');

console.log(`\n${passed} passed, ${failures} failed.\n`);
if (failures > 0) process.exitCode = 1;
