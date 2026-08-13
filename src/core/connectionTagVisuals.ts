export interface TagVisuals {
    emoji: string;
    hex: string;
    label: string;
}

export const TAG_VISUALS: Record<string, TagVisuals> = {
    production: { emoji: '🚨', hex: '#DC2626', label: 'PROD' },
    staging:    { emoji: '⚠️', hex: '#EAB308', label: 'STAGING' },
    dev:        { emoji: '✅', hex: '#16A34A', label: 'DEV' },
    reporting:  { emoji: 'ℹ️', hex: '#2563EB', label: 'REPORTING' },
};

export function normalizeConnectionTag(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
}

export function getTagVisuals(tag: unknown): TagVisuals | undefined {
    const norm = normalizeConnectionTag(tag);
    if (!norm) return undefined;
    return TAG_VISUALS[norm];
}

// Reads the raw tag off a ConnectionProfile, tolerating the legacy `.tag` field.
export function readConnectionTagRaw(profile: unknown): string | undefined {
    if (!profile || typeof profile !== 'object') return undefined;
    const p = profile as { connectionTag?: unknown; tag?: unknown };
    const raw = p.connectionTag ?? p.tag;
    return typeof raw === 'string' ? raw : undefined;
}
