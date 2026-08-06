export type ChangelogEntry = {
    version: string;
    date?: string;
    markdown: string;
};

type VersionBlock = {
    version: string;
    date?: string;
    body: string;
};

const VERSION_HEADING_PATTERN = /^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?\s*$/gm;

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
        markdown: targetBlock.body
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
