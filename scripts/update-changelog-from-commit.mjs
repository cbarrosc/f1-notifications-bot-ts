import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const commitMessagePath = process.argv[2];

if (!commitMessagePath) {
  process.exit(0);
}

const firstLine = readFileSync(commitMessagePath, 'utf8').split('\n')[0]?.trim() ?? '';
const conventionalCommitPattern = /^([a-z]+)(\(([^)]+)\))?(!)?:\s+(.+)$/;
const match = conventionalCommitPattern.exec(firstLine);

if (!match) {
  process.exit(0);
}

const [, rawType, , rawScope, , rawSubject] = match;
const type = rawType.toLowerCase();
const scope = rawScope?.trim();
const subject = rawSubject.trim();

const sectionByType = {
  feat: 'Features',
  fix: 'Bug Fixes',
  docs: 'Documentation',
  test: 'Tests',
  refactor: 'Refactors',
  chore: 'Chores',
  perf: 'Performance',
  build: 'Build',
  ci: 'CI',
};

const sectionTitle = sectionByType[type] ?? 'Other';
const bullet = `- ${scope ? `${scope}: ` : ''}${subject}`;

const defaultChangelog = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  '## Unreleased',
  '',
].join('\n');

const changelogPath = process.env.CHANGELOG_PATH ?? 'CHANGELOG.md';
const current = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : defaultChangelog;
const normalized = current.endsWith('\n') ? current : `${current}\n`;

if (normalized.includes(`\n${bullet}\n`) || normalized.endsWith(`\n${bullet}`)) {
  process.exit(0);
}

const unreleasedHeading = '## Unreleased';
const unreleasedIndex = normalized.indexOf(unreleasedHeading);

let changelog = normalized;
if (unreleasedIndex === -1) {
  changelog = `${normalized.trimEnd()}\n\n## Unreleased\n\n`;
}

const lines = changelog.split('\n');
const unreleasedLineIndex = lines.findIndex((line) => line === unreleasedHeading);
const nextVersionHeadingIndex = lines.findIndex(
  (line, index) => index > unreleasedLineIndex && /^## /.test(line),
);
const unreleasedEnd = nextVersionHeadingIndex === -1 ? lines.length : nextVersionHeadingIndex;
const unreleasedLines = lines.slice(unreleasedLineIndex + 1, unreleasedEnd);

let insertAt = unreleasedLineIndex + 1;
while (insertAt < lines.length && lines[insertAt] === '') {
  insertAt += 1;
}

const sectionLine = `### ${sectionTitle}`;
const existingSectionOffset = unreleasedLines.findIndex((line) => line === sectionLine);

if (existingSectionOffset === -1) {
  const prefix = lines.slice(0, insertAt);
  const suffix = lines.slice(insertAt);
  // Keep the unreleased section compact when creating its first subsection.
  const insertion = prefix.at(-1) === '' ? [sectionLine, '', bullet, ''] : ['', sectionLine, '', bullet, ''];
  writeFileSync(changelogPath, [...prefix, ...insertion, ...suffix].join('\n'));
  process.exit(0);
}

let sectionStart = unreleasedLineIndex + 1 + existingSectionOffset;
let bulletInsertAt = sectionStart + 1;
while (bulletInsertAt < unreleasedEnd && lines[bulletInsertAt] === '') {
  bulletInsertAt += 1;
}

const updatedLines = [...lines];
updatedLines.splice(bulletInsertAt, 0, bullet);

writeFileSync(changelogPath, updatedLines.join('\n'));
