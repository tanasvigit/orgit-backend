/**
 * Builder Renderer Service
 * This service converts the DocumentBuilder state (stored in filledData) into a complete HTML string
 * that matches the frontend's LivePreview but with high-quality styling for PDF generation.
 */

export interface BuilderState {
    header: {
        layout: 'left' | 'center' | 'right';
        showLogo: boolean;
        orgDetailsVisible: boolean;
        orgName: string;
        orgAddress: string;
        orgGstin: string;
        orgEmail: string;
        orgMobile?: string;
        logoUrl?: string;
    };
    meta: {
        type: string;
    };
    documentData: {
        clientName: string;
        date: string;
        referenceNo: string;
    };
    sections: any[];
}

export function renderDocumentFromState(state: BuilderState): string {
    const headerLayout = state.header.layout || 'left';
    const textAlign = headerLayout === 'center' ? 'center' : headerLayout === 'right' ? 'right' : 'left';
    const itemsAlign = headerLayout === 'center' ? 'center' : headerLayout === 'right' ? 'flex-end' : 'flex-start';

    // Helper for currency
    const formatINR = (amount: number) => {
        return '₹' + amount.toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    };

    // 1. Generate Header HTML — only show logo box when we have an actual logo URL (no empty box in PDF)
    const showLogoBox = state.header.showLogo && !!state.header.orgLogoUrl;
    const headerHTML = `
    <header style="display: flex; flex-direction: column; align-items: ${itemsAlign}; border-bottom: 2px solid #334155; padding-bottom: 20px; margin-bottom: 30px; text-align: ${textAlign};">
      ${showLogoBox ? `
        <div style="width: 80px; height: 80px; background-color: #f1f5f9; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; overflow: hidden;">
          <img src="${state.header.orgLogoUrl}" alt="Company Logo" style="width: 100%; height: 100%; object-fit: contain;" />
        </div>
      ` : ''}
      ${state.header.orgDetailsVisible ? `
        <div>
          <h1 style="font-size: 24px; font-weight: bold; margin: 0; color: #0f172a;">${state.header.orgName || 'Organization Name'}</h1>
          <p style="font-size: 12px; color: #64748b; margin: 4px 0; max-width: 400px; line-height: 1.4;">${state.header.orgAddress || ''}</p>
          <div style="font-size: 11px; color: #64748b; margin-top: 4px;">
            ${state.header.orgGstin ? `<span style="margin-right: 12px;">GSTIN: <strong>${state.header.orgGstin}</strong></span>` : ''}
            ${state.header.orgEmail ? `<span style="margin-right: 12px;">Email: ${state.header.orgEmail}</span>` : ''}
            ${state.header.orgMobile ? `<span>Mobile: ${state.header.orgMobile}</span>` : ''}
          </div>
        </div>
      ` : ''}
    </header>
  `;

    // 2. Generate Meta Info (Invoice details)
    const metaHTML = `
    <div style="margin-bottom: 30px; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px;">
      <h2 style="font-size: 20px; font-weight: 800; color: #1e293b; margin: 0; text-transform: uppercase; letter-spacing: 0.05em;">${state.meta.type || 'Document'}</h2>
      <div style="display: flex; justify-content: space-between; margin-top: 15px; font-size: 13px;">
        <div style="color: #475569;">
          <span style="font-weight: 600; color: #1e293b;">To:</span> ${state.documentData.clientName || ''}
        </div>
        <div style="text-align: right; color: #475569;">
          <div><span style="font-weight: 600; color: #1e293b;">Date:</span> ${state.documentData.date || new Date().toLocaleDateString('en-IN')}</div>
          <div style="margin-top: 2px;"><span style="font-weight: 600; color: #1e293b;">Ref No:</span> ${state.documentData.referenceNo || ''}</div>
        </div>
      </div>
    </div>
  `;

    // 3. Generate Sections
    const sectionsHTML = state.sections.map(section => {
        if (!section.isVisible) return '';

        if (section.type === 'text') {
            return `<div style="margin-bottom: 20px; font-size: 14px; line-height: 1.6; color: #334155;">${section.content || ''}</div>`;
        }

        if (section.type === 'key-value') {
            const items = section.items || [];
            const cols = section.layout === '1-col' ? 1 : section.layout === '3-col' ? 3 : 2;

            return `
        <div style="display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 15px; margin-bottom: 25px; border: 1px solid #f1f5f9; padding: 15px; border-radius: 8px;">
          ${items.map((item: any) => `
            <div style="margin-bottom: 5px;">
              <span style="font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; display: block;">${item.key}</span>
              <span style="font-size: 13px; color: #334155; font-weight: 500;">${item.value || '-'}</span>
            </div>
          `).join('')}
        </div>
      `;
        }

        if (section.type === 'table') {
            const columns = section.columns || [];
            const rows = section.rows || [];

            // Calculate Total Amount for this table
            let amountCol = columns.find((c: any) => c.key === 'amount');
            if (!amountCol) {
                const amountCols = columns.filter((c: any) => c.type === 'amount');
                if (amountCols.length > 0) amountCol = amountCols[amountCols.length - 1];
            }

            const totalAmount = rows.reduce((sum: number, row: any) => {
                const val = row[amountCol?.key || 'amount'];
                return sum + (parseFloat(val) || 0);
            }, 0);

            const headers = columns.map((c: any) => `
        <th style="padding: 10px 8px; text-align: left; font-size: 11px; font-weight: 700; color: #334155; text-transform: uppercase; border-bottom: 2px solid #cbd5e1; background-color: #f8fafc; width: ${c.width || 'auto'};">
          ${c.header}
        </th>
      `).join('');

            const cells = (rows.length > 0 ? rows : [{}]).map((row: any) => `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          ${columns.map((c: any) => {
                let val = row[c.key] || '-';
                if (c.type === 'amount' || c.key === 'amount') val = formatINR(parseFloat(val) || 0);
                return `<td style="padding: 10px 8px; font-size: 13px; color: #475569;">${val}</td>`;
            }).join('')}
        </tr>
      `).join('');

            return `
        <div style="margin-bottom: 25px;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead><tr>${headers}</tr></thead>
            <tbody>${cells}</tbody>
            ${section.showTotal ? `
              <tfoot>
                <tr>
                  <td colspan="${columns.length - 1}" style="text-align: right; padding: 12px 8px; font-weight: 700; font-size: 13px; color: #1e293b;">Total:</td>
                  <td style="padding: 12px 8px; text-align: left; font-weight: 800; font-size: 13px; color: #0f172a; background-color: #f1f5f9;">${formatINR(totalAmount)}</td>
                </tr>
              </tfoot>
            ` : ''}
          </table>
        </div>
      `;
        }

        if (section.type === 'amount-summary') {
            const grandTotal = state.sections.reduce((total, s) => {
                if (s.type === 'table') {
                    let amCol = s.columns.find((c: any) => c.key === 'amount');
                    if (!amCol) {
                        const amCols = s.columns.filter((c: any) => c.type === 'amount');
                        if (amCols.length > 0) amCol = amCols[amCols.length - 1];
                    }
                    const tSum = (s.rows || []).reduce((sum: number, row: any) => sum + (parseFloat(row[amCol?.key || 'amount']) || 0), 0);
                    return total + tSum;
                }
                return total;
            }, 0);

            return `
        <div style="display: flex; justify-content: flex-end; margin-top: 20px;">
          <table style="width: 50%; border-collapse: collapse;">
            <tbody>
              ${(section.fields || []).map((f: any) => {
                const isTotal = f.label.toLowerCase().includes('total');
                const val = isTotal ? grandTotal : 0;
                return `
                  <tr style="${isTotal ? 'border-top: 2px solid #0f172a;' : ''}">
                    <td style="padding: 6px 0; font-size: 13px; color: #64748b; font-weight: 500;">${f.label}</td>
                    <td style="padding: 6px 0; text-align: right; font-size: 14px; font-weight: ${isTotal ? '800' : '600'}; color: #0f172a;">${formatINR(val)}</td>
                  </tr>
                `;
            }).join('')}
            </tbody>
          </table>
        </div>
      `;
        }

        if (section.type === 'signature') {
            return `
        <div style="margin-top: 60px; display: flex; justify-content: flex-end;">
          <div style="text-align: center; min-width: 200px;">
            <div style="height: 50px;"></div>
            <div style="border-top: 1px solid #0f172a; padding-top: 6px;">
              <p style="margin: 0; font-size: 13px; font-weight: 700; color: #0f172a;">${section.signatoryLabel || 'Authorized Signatory'}</p>
              <p style="margin: 2px 0 0; font-size: 11px; color: #64748b;">${section.label || 'Signature'}</p>
            </div>
          </div>
        </div>
      `;
        }

        return '';
    }).join('\n');

    // Wrap in complete HTML
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${state.meta.type || 'Document'}</title>
      <style>
        @page { margin: 20mm; }
        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background: white; -webkit-print-color-adjust: exact; }
        * { box-sizing: border-box; }
      </style>
    </head>
    <body>
      ${headerHTML}
      ${metaHTML}
      <div class="content">
        ${sectionsHTML}
      </div>
      <footer style="position: fixed; bottom: 0; width: 100%; border-top: 1px solid #e2e8f0; padding-top: 10px; font-size: 10px; color: #94a3b8; text-align: center;">
        Page 1 of 1
      </footer>
    </body>
    </html>
  `.trim();
}
