export type ChangelogSection = {
    title: string;
    paragraphs: string[];
    items: string[];
};

export type ChangelogEntry = {
    version: string;
    date?: string;
    sections: ChangelogSection[];
};

type VersionBlock = {
    version: string;
    date?: string;
    body: string;
};

const VERSION_HEADING_PATTERN = /^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?\s*$/gm;
const SECTION_HEADING_PATTERN = /^###\s+(.+)$/;
const LIST_ITEM_PATTERN = /^(?:[-*]|\d+\.)\s+(.+)$/;

export function parseChangelogEntry(markdown: string, version?: string): ChangelogEntry | undefined {
    const blocks = getVersionBlocks(markdown);
    const targetBlock = version
        ? blocks.find(block => block.version === version)
        : blocks.find(block => block.version.toLowerCase() !== 'unreleased');

    if (!targetBlock) {
        return undefined;
    }

    return {
        version: targetBlock.version,
        date: targetBlock.date,
        sections: parseSections(targetBlock.body)
    };
}

function getVersionBlocks(markdown: string): VersionBlock[] {
    const headings = Array.from(markdown.matchAll(VERSION_HEADING_PATTERN));

    return headings.map((match, index) => {
        const end = index + 1 < headings.length
            ? headings[index + 1].index ?? markdown.length
            : markdown.length;

        return {
            version: match[1].trim(),
            date: match[2]?.trim(),
            body: markdown.slice((match.index ?? 0) + match[0].length, end).trim()
        };
    });
}

function parseSections(body: string): ChangelogSection[] {
    const sections: ChangelogSection[] = [];
    let current: ChangelogSection | undefined;

    const ensureSection = () => {
        if (!current) {
            current = { title: 'Changes', paragraphs: [], items: [] };
            sections.push(current);
        }
        return current;
    };

    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const heading = SECTION_HEADING_PATTERN.exec(line);
        if (heading) {
            current = { title: heading[1].trim(), paragraphs: [], items: [] };
            sections.push(current);
            continue;
        }

        const listItem = LIST_ITEM_PATTERN.exec(line);
        if (listItem) {
            ensureSection().items.push(listItem[1].trim());
            continue;
        }

        ensureSection().paragraphs.push(line);
    }

    return sections.filter(section => section.paragraphs.length > 0 || section.items.length > 0);
}
