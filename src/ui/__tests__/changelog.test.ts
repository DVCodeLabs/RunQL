import { parseChangelogEntry } from '../changelog';

describe('parseChangelogEntry', () => {
    it('returns the changelog section that matches the requested version', () => {
        const entry = parseChangelogEntry(`# Changelog

## [Unreleased]

### Added
- Future work

## [1.10.0]

### Added
- Add query approval support for SecureQL connections.

## [1.9.1] - 2026-05-21

### Changes
- Rename support
`, '1.10.0');

        expect(entry).toEqual({
            version: '1.10.0',
            date: undefined,
            sections: [
                {
                    title: 'Added',
                    paragraphs: [],
                    items: ['Add query approval support for SecureQL connections.']
                }
            ]
        });
    });

    it('uses the latest released entry when no version is provided', () => {
        const entry = parseChangelogEntry(`# Changelog

## [Unreleased]

### Added
- Future work

## [1.9.1] - 2026-05-21

### Changes
Archive deleted schema(s) during introspection refresh
- Move removed schemas into archives
`);

        expect(entry?.version).toBe('1.9.1');
        expect(entry?.date).toBe('2026-05-21');
        expect(entry?.sections[0].paragraphs).toEqual(['Archive deleted schema(s) during introspection refresh']);
        expect(entry?.sections[0].items).toEqual(['Move removed schemas into archives']);
    });
});
