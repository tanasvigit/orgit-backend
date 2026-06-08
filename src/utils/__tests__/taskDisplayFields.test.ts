import {
  deriveOrgStructurePathDisplay,
  deriveTaskUnitDisplay,
  deriveTaskUnitFromOrgPath,
  enrichTaskDisplayFields,
} from '../taskDisplayFields';

describe('taskDisplayFields', () => {
  it('derives full path display from org_structure_path array', () => {
    const display = deriveOrgStructurePathDisplay([
      { name: 'Region A', levelLabel: 'Region' },
      { name: 'depo1', levelLabel: 'Location', code: 'D1' },
    ]);
    expect(display).toBe('Region A > depo1');
  });

  it('derives task unit as selected node label (create-form style)', () => {
    const unit = deriveTaskUnitFromOrgPath([
      { name: 'Region A', levelLabel: 'Region' },
      { name: 'depo1', levelLabel: 'Location', code: 'D1' },
    ]);
    expect(unit).toBe('Location: depo1 [D1]');
  });

  it('derives path display from JSON string', () => {
    const display = deriveOrgStructurePathDisplay('[{"name":"HQ"},{"name":"Sales"}]');
    expect(display).toBe('HQ > Sales');
  });

  it('enriches task_unit from org_structure_path when legacy column absent', () => {
    const enriched = enrichTaskDisplayFields({
      id: 't1',
      org_structure_path: [{ name: 'dist1', levelLabel: 'Warehouse / Distribution', code: 'DIS1' }],
    });
    expect(deriveTaskUnitDisplay(enriched)).toBe('Warehouse / Distribution: dist1 [DIS1]');
  });

  it('prefers org path leaf label over legacy full-path task_unit', () => {
    const enriched = enrichTaskDisplayFields({
      id: 't2',
      task_unit: 'Region A > depo1',
      org_structure_path: [
        { name: 'Region A', levelLabel: 'Region' },
        { name: 'depo1', levelLabel: 'Location', code: 'D1' },
      ],
    });
    expect(deriveTaskUnitDisplay(enriched)).toBe('Location: depo1 [D1]');
  });

  it('uses legacy task_unit when org_structure_path is absent', () => {
    expect(deriveTaskUnitDisplay({ task_unit: 'Location: depo1 [D1]' })).toBe('Location: depo1 [D1]');
  });
});
