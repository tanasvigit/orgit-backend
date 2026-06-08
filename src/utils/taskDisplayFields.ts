/**
 * Derive human-readable task unit / org path labels from persisted task fields.
 * Task cards show the selected org unit label (same as create form), not the full hierarchy path.
 */

export function formatOrgStructureSegmentLabel(
  segment: Record<string, unknown> | string | null | undefined
): string {
  if (segment == null) return '';
  if (typeof segment === 'string') return segment.trim();

  const name = String(segment.name ?? '').trim();
  const levelLabel = String(segment.levelLabel ?? segment.level_label ?? '').trim();
  const code = String(segment.code ?? '').trim();
  const base = levelLabel && name ? `${levelLabel}: ${name}` : name || levelLabel;
  if (!base) return '';
  return code ? `${base} [${code}]` : base;
}

function parseOrgPathSegments(path: unknown): Array<Record<string, unknown> | string> {
  if (path == null) return [];

  if (typeof path === 'string') {
    const trimmed = path.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return parseOrgPathSegments(JSON.parse(trimmed));
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }

  if (Array.isArray(path)) {
    return path.filter((segment) => segment != null) as Array<Record<string, unknown> | string>;
  }

  if (typeof path === 'object') {
    const record = path as Record<string, unknown>;
    if (Array.isArray(record.path)) {
      return parseOrgPathSegments(record.path);
    }
  }

  return [];
}

/** Selected org unit label (matches task create dropdown), not the full ancestor path. */
export function deriveTaskUnitFromOrgPath(path: unknown): string | null {
  const segments = parseOrgPathSegments(path);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1];
  const label = formatOrgStructureSegmentLabel(last);
  return label || null;
}

/** Full hierarchy path (e.g. for detail / debugging). */
export function deriveOrgStructurePathDisplay(path: unknown): string | null {
  if (path == null) return null;

  if (typeof path === 'string') {
    const trimmed = path.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return deriveOrgStructurePathDisplay(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (Array.isArray(path)) {
    const names = path
      .map((segment) => {
        if (segment == null) return '';
        if (typeof segment === 'string') return segment.trim();
        if (typeof segment === 'object') {
          const record = segment as Record<string, unknown>;
          const name = record.name ?? record.label ?? record.title;
          return typeof name === 'string' ? name.trim() : '';
        }
        return '';
      })
      .filter(Boolean);
    if (names.length > 0) return names.join(' > ');
  }

  if (typeof path === 'object') {
    const record = path as Record<string, unknown>;
    const display = record.pathDisplay ?? record.display;
    if (typeof display === 'string' && display.trim()) return display.trim();
  }

  return null;
}

function normalizeLegacyTaskUnitString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes(' > ')) return trimmed;
  const parts = trimmed.split(' > ').map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

export function deriveTaskUnitDisplay(task: Record<string, unknown> | null | undefined): string | null {
  if (!task) return null;

  const fromPath = deriveTaskUnitFromOrgPath(task.org_structure_path ?? task.orgStructurePath);
  if (fromPath) return fromPath;

  for (const key of ['task_unit', 'task_unit_name', 'taskUnit', 'taskUnitName']) {
    const value = task[key];
    if (typeof value === 'string' && value.trim()) {
      return normalizeLegacyTaskUnitString(value);
    }
  }

  return null;
}

export function enrichTaskDisplayFields<T extends Record<string, unknown>>(task: T): T {
  if (!task || typeof task !== 'object') return task;

  const taskUnit = deriveTaskUnitDisplay(task);
  const orgPathDisplay = deriveOrgStructurePathDisplay(
    task.org_structure_path ?? task.orgStructurePath
  );

  const enriched = { ...task } as T & { task_unit?: string; org_structure_path_display?: string };
  if (taskUnit) enriched.task_unit = taskUnit;
  if (orgPathDisplay) enriched.org_structure_path_display = orgPathDisplay;
  return enriched as T;
}
