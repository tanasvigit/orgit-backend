/**
 * Forces GST Invoice (Figma) desktop table layout during PDF render.
 * Puppeteer uses print media — responsive mobile rules in stored templates can still stack cells.
 */
export const GST_INVOICE_PDF_LAYOUT_LOCK_CSS = `
body.gst-inv-pdf-render .gst-inv-header-block tr,
body.gst-inv-pdf-render .gst-inv-grid tr,
body.gst-inv-pdf-render .gst-inv-bottom-3col tr,
body.gst-inv-pdf-render .gst-inv-notes-terms tr {
  display: table-row !important;
}
body.gst-inv-pdf-render .gst-inv-header-block td,
body.gst-inv-pdf-render .gst-inv-grid td,
body.gst-inv-pdf-render .gst-inv-bottom-3col td,
body.gst-inv-pdf-render .gst-inv-notes-terms td {
  display: table-cell !important;
}
body.gst-inv-pdf-render .gst-inv-company-cell { width: 58% !important; }
body.gst-inv-pdf-render .gst-inv-invoice-cell { width: 42% !important; }
body.gst-inv-pdf-render .gst-inv-addr-cell { width: 50% !important; }
body.gst-inv-pdf-render .gst-inv-bank-cell { width: 38% !important; }
body.gst-inv-pdf-render .gst-inv-qr-cell { width: 24% !important; }
body.gst-inv-pdf-render .gst-inv-sign-cell { width: 38% !important; }
body.gst-inv-pdf-render .gst-inv-notes-cell,
body.gst-inv-pdf-render .gst-inv-terms-cell { width: 50% !important; }
body.gst-inv-pdf-render .gst-inv-page {
  width: 794px !important;
  max-width: 100% !important;
  margin: 0 auto !important;
  border: 1px solid #000 !important;
}
body.gst-inv-pdf-render .gst-inv-page-footer {
  flex-direction: row !important;
  justify-content: space-between !important;
}
body.gst-inv-pdf-render .gst-inv-items-table,
body.gst-inv-pdf-render .gst-inv-gst-table {
  min-width: 0 !important;
  width: 100% !important;
  table-layout: fixed !important;
}
body.gst-inv-pdf-render .gst-inv-table-scroll {
  overflow: visible !important;
}
`;

export function isGstInvoiceHtml(html: string): boolean {
  return /gst-inv-page|gst-inv-root|gst_invoice_figma/i.test(html || '');
}

export function injectGstInvoicePdfLayoutLock(html: string): string {
  if (!isGstInvoiceHtml(html)) return html;

  const lockStyle = `<style id="gst-inv-pdf-layout-lock">${GST_INVOICE_PDF_LAYOUT_LOCK_CSS}</style>`;
  let out = html;

  if (out.includes('</head>')) {
    out = out.replace('</head>', `${lockStyle}</head>`);
  } else {
    out = `<!DOCTYPE html><html><head>${lockStyle}</head><body class="gst-inv-pdf-render">${out}</body></html>`;
  }

  if (/<body[^>]*class="/i.test(out)) {
    out = out.replace(/<body([^>]*?)class="([^"]*)"/i, (match, before, classes) => {
      if (classes.includes('gst-inv-pdf-render')) return match;
      return `<body${before}class="gst-inv-pdf-render ${classes}"`;
    });
  } else {
    out = out.replace(/<body([^>]*)>/i, '<body class="gst-inv-pdf-render"$1>');
  }

  if (!/gst-inv-root/i.test(out) && /gst-inv-page/i.test(out)) {
    out = out.replace(/(<body[^>]*>)/i, '$1<div class="gst-inv-root">');
    out = out.replace(/<\/body>/i, '</div></body>');
  }

  return out;
}
