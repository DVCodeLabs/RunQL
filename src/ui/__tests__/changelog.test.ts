import { parseChangelogEntry } from '../changelog';

describe('parseChangelogEntry', () => {
    it('returns the changelog markdown that matches the requested version', () => {
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
            markdown: '### Added\n- Add query approval support for SecureQL connections.'
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
        expect(entry?.markdown).toBe('### Changes\nArchive deleted schema(s) during introspection refresh\n- Move removed schemas into archives');
    });

    it('preserves headings, ordered lists, nested lists, and paragraph order', () => {
        const entry = parseChangelogEntry(`# Changelog

## [1.16.1]

### Changes

#### Support for developers using RunQL with multiple code projects or GitHub Codespaces.

RunQL now lets you choose where your RunQL files are stored. You have three options:
1. Project workspace = project-specific RunQL workspace
2. User home = one personal RunQL workspace
    - macOS/Linux: ~/.runql
    - Windows: %USERPROFILE%\\.runql
    - Codespaces: /workspaces/.runql
3. Custom path = explicit folder you control

Fix: Normalize doc paths to forward slashes for Windows

## [1.16.0]

### Changes
- Previous release
`, '1.16.1');

        expect(entry).toBeDefined();
        const markdown = entry!.markdown;
        expect(markdown).toContain('### Changes');
        expect(markdown).toContain('#### Support for developers using RunQL with multiple code projects or GitHub Codespaces.');
        expect(markdown).toContain('1. Project workspace = project-specific RunQL workspace');
        expect(markdown).toContain('    - macOS/Linux: ~/.runql');
        expect(markdown).toContain('3. Custom path = explicit folder you control');
        expect(markdown).toContain('Fix: Normalize doc paths to forward slashes for Windows');
        expect(markdown.indexOf('3. Custom path')).toBeLessThan(markdown.indexOf('Fix: Normalize'));
        expect(markdown).not.toContain('## [1.16.0]');
    });
});
