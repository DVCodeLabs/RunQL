import * as fs from 'fs';
import * as path from 'path';

interface CommandDef {
  command: string;
  title: string;
  category?: string;
}

interface MenuItem {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

interface SubmenuDef {
  id: string;
  label: string;
}

interface PkgContributes {
  commands: CommandDef[];
  submenus?: SubmenuDef[];
  menus: Record<string, MenuItem[]>;
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
);
const contributes = pkg.contributes as PkgContributes;

const TABLE_COMMANDS: Array<{ command: string; title: string }> = [
  { command: 'runql.schema.copyTableName', title: 'Copy Name' },
  { command: 'runql.schema.editTable', title: 'Edit Table' },
  { command: 'runql.schema.showTableDdl', title: 'Show Table DDL' },
  { command: 'runql.schema.sqlTemplate.select', title: 'SELECT' },
  { command: 'runql.schema.sqlTemplate.insert', title: 'INSERT' },
  { command: 'runql.schema.sqlTemplate.update', title: 'UPDATE' },
  { command: 'runql.schema.sqlTemplate.delete', title: 'DELETE' },
  { command: 'runql.schema.dumpStructure', title: 'Dump Structure' },
  { command: 'runql.schema.dumpStructureAndData', title: 'Dump Structure And Data' },
  { command: 'runql.schema.generateMockData', title: 'Generate Mock Data' },
  { command: 'runql.schema.dropTable', title: 'Drop' },
  { command: 'runql.schema.copyTable', title: 'Copy Table' },
  { command: 'runql.schema.truncateTable', title: 'Truncate Table' },
];

describe('table context menu package.json contributions', () => {
  test.each(TABLE_COMMANDS)('command %o exists with expected title', ({ command, title }) => {
    const def = contributes.commands.find((c) => c.command === command);
    expect(def).toBeDefined();
    expect(def!.title).toBe(title);
  });

  it('declares the SQL Template submenu', () => {
    const submenu = contributes.submenus?.find((s) => s.id === 'runql.schema.sqlTemplateMenu');
    expect(submenu).toBeDefined();
    expect(submenu!.label).toBe('SQL Template');
  });

  it('SQL Template submenu contains exactly SELECT/INSERT/UPDATE/DELETE', () => {
    const items = contributes.menus['runql.schema.sqlTemplateMenu'] || [];
    const commandIds = items.map((i) => i.command).sort();
    expect(commandIds).toEqual(
      [
        'runql.schema.sqlTemplate.delete',
        'runql.schema.sqlTemplate.insert',
        'runql.schema.sqlTemplate.select',
        'runql.schema.sqlTemplate.update',
      ]
    );
  });

  it('no context-menu label uses the abbreviation "Struct"', () => {
    const contextItems = contributes.menus['view/item/context'] || [];
    for (const item of contextItems) {
      const cmd = item.command;
      if (!cmd) continue;
      const def = contributes.commands.find((c) => c.command === cmd);
      if (!def) continue;
      // Must not contain "Struct" as a standalone word (allow "Structure").
      expect(def.title).not.toMatch(/\bStruct\b/);
    }
    // Also assert submenu label
    for (const sm of contributes.submenus || []) {
      expect(sm.label).not.toMatch(/\bStruct\b/);
    }
  });

  it('table-only entries include all three table context values and both views', () => {
    const contextItems = contributes.menus['view/item/context'] || [];
    const tableOnlyCommands = new Set(TABLE_COMMANDS.map((c) => c.command));
    for (const item of contextItems) {
      if (!item.command || !tableOnlyCommands.has(item.command)) continue;
      if (!item.group || !/^(1_copy|2_manage|3_generate|4_destructive)/.test(item.group)) continue;
      const when = item.when || '';
      expect(when).toMatch(/runql\.explorerView/);
      expect(when).toMatch(/runql\.explorerViewBuiltin/);
      expect(when).toMatch(/viewItem == runql\.schema\.table\b/);
      // Reserved must be included for every entry in this group.
      expect(when).toMatch(/runql\.schema\.table\.reserved/);
      // dumpStructureAndData is the only one that excludes .noexport.
      if (item.command !== 'runql.schema.dumpStructureAndData') {
        expect(when).toMatch(/runql\.schema\.table\.noexport/);
      } else {
        expect(when).not.toMatch(/runql\.schema\.table\.noexport/);
      }
    }
  });

  it('table-only entries do not target schema/connection/view/column context values', () => {
    const contextItems = contributes.menus['view/item/context'] || [];
    const tableOnlyCommands = new Set(TABLE_COMMANDS.map((c) => c.command));
    for (const item of contextItems) {
      if (!item.command || !tableOnlyCommands.has(item.command)) continue;
      if (!item.group || !/^(1_copy|2_manage|3_generate|4_destructive)/.test(item.group)) continue;
      const when = item.when || '';
      expect(when).not.toMatch(/runql\.schema\.schema\b/);
      expect(when).not.toMatch(/runql\.schema\.view\b/);
      expect(when).not.toMatch(/runql\.schema\.column/);
      expect(when).not.toMatch(/runql\.schema\.folder/);
      expect(when).not.toMatch(/runql\.connection\.item/);
      expect(when).not.toMatch(/runql\.schema\.function/);
      expect(when).not.toMatch(/runql\.schema\.procedure/);
    }
  });

  it('groups follow the specified prefixes', () => {
    const expectedGroups: Record<string, string> = {
      'runql.schema.copyTableName': '1_copy@1',
      'runql.schema.editTable': '2_manage@1',
      'runql.schema.showTableDdl': '2_manage@2',
      'runql.schema.dumpStructure': '3_generate@2',
      'runql.schema.dumpStructureAndData': '3_generate@3',
      'runql.schema.generateMockData': '3_generate@4',
      'runql.schema.dropTable': '4_destructive@1',
      'runql.schema.copyTable': '4_destructive@2',
      'runql.schema.truncateTable': '4_destructive@3',
    };
    const contextItems = contributes.menus['view/item/context'] || [];
    for (const [command, group] of Object.entries(expectedGroups)) {
      const matches = contextItems.filter(
        (i) => i.command === command && i.group === group
      );
      expect(matches.length).toBeGreaterThan(0);
    }
    // SQL Template submenu contribution uses 3_generate@1.
    const submenuItems = contextItems.filter(
      (i) => i.submenu === 'runql.schema.sqlTemplateMenu' && i.group === '3_generate@1'
    );
    expect(submenuItems.length).toBeGreaterThan(0);
  });
});
