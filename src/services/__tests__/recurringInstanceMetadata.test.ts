import {
  mergeRecurrenceMetadataLayers,
  buildCopiedInstanceMetadata,
} from '../recurringTaskService';

describe('recurring instance metadata merge', () => {
  it('prefers anchor task values over template snapshot', () => {
    const merged = mergeRecurrenceMetadataLayers([
      {
        client_name: 'aaa',
        compliance_id: 'comp-1',
        document_instance_id: 'doc-1',
        financial_value: 100,
        category: 'tax',
        end_date: '2026-12-31',
      },
      {
        client_name: 'template-only',
        org_structure_node_id: 'node-1',
      },
    ]);

    expect(merged.client_name).toBe('aaa');
    expect(merged.compliance_id).toBe('comp-1');
    expect(merged.document_instance_id).toBe('doc-1');
    expect(merged.financial_value).toBe(100);
    expect(merged.category).toBe('tax');
    expect(merged.end_date).toBe('2026-12-31');
    expect(merged.org_structure_node_id).toBe('node-1');
  });

  it('defaults escalation_status to none when column exists', () => {
    const columns = new Set([
      'client_name',
      'auto_escalate',
      'escalation_status',
      'escalation_trigger',
    ]);
    const picked = buildCopiedInstanceMetadata(
      { client_name: 'client', auto_escalate: true },
      columns
    );
    expect(picked.escalation_status).toBe('none');
    expect(picked.client_name).toBe('client');
  });
});
